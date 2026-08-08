#!/bin/sh
# Publish client/public/world to Cloudflare R2, one hexagon at a time.
#
# WHY R2, AND WHY NOW. `scripts/publish-world.sh` puts the world in a GitHub
# data repo and serves it from jsDelivr. That works and it is still here -- this
# is a **second target, not a replacement** -- but it is finished as a growth
# path: the data repo is at 4.1 GB against GitHub's 5 GB ceiling, pushes are
# already sliced to dodge the 2 GB-per-push limit, and jsDelivr is a courtesy
# service on top of a repo rather than a contract. `EXPANSION.md` measures the
# 60 km world at ~20 GB, which is four times a limit we are already touching.
#
# R2 because the decisive property is not price but **zero egress fees**. A
# world players stream is an egress problem, and R2 is the only mainstream
# object store that does not bill for it. At 20 GB stored and two million reads
# a month it is well under a dollar; the same traffic on S3/CloudFront is ~$34
# per thousand first visits.
#
# ---------------------------------------------------------------------------
# WHAT THE CLIENT SEES. One key in `index.json` and `root.json`:
#
#     "cdn": { "base": "https://world.3rp.uk" }
#
# and `client/src/world/cdn.ts` concatenates. `base` takes precedence over the
# `ref`/`repo` pair jsDelivr uses, so pointing the world at either host is a
# stamp rather than a client deploy, and a world with neither loads from the
# origin exactly as it always did.
#
# **There is no ref in an R2 URL and there does not need to be one.** jsDelivr
# needed `@<sha>` because it caches a *path* forever and the world's paths
# repeat across builds. Immutability here comes from where it has always come
# from: the `?v=<built>` suffix in `client/src/world/version.ts`, which every
# asset but the two pivots carries. This script uploads the payload with a
# one-year immutable `Cache-Control` and the two pivots with `no-cache`, which
# is the same split `caddy/world-cache.Caddyfile` makes on the origin.
#
# ---------------------------------------------------------------------------
# ONE HEXAGON AT A TIME. `sydney hex-pack` cuts the world into hexagonal
# segments (`pipeline/sydney/hexes.py`), and a hex is the unit of work
# everywhere -- build, publish, and the player's download. `--hex h-01+01`
# uploads exactly that hexagon's tiles, collision, region bundles and manifests
# and nothing else, so a rebuilt segment costs one segment's upload rather than
# 20 GB. The object keys are still the world's own paths (`tiles/-5_9.glb`),
# because the client's URL builder is a concatenation and must stay one; the
# hexagon is the *selection*, not a prefix in the key.
#
# Every upload is idempotent: rclone compares checksums and moves only what
# changed, so re-running this on an unchanged world transfers nothing.
#
# ---------------------------------------------------------------------------
# CREDENTIALS. From the environment, never from this file and never printed:
#
#     R2_ACCESS_KEY_ID       an R2 API token's access key id
#     R2_SECRET_ACCESS_KEY   its secret
#
# sourced from `/etc/sydney/secrets.env` (mode 0600, outside `/opt/sydney` so no
# deploy rsync can put it in a public repo) or from `$SYDNEY_SECRETS`. The
# account id below is **not** a secret -- it is the hostname of the S3 endpoint.
#
# ---------------------------------------------------------------------------
# A TRAP, RECORDED SO NOBODY PAYS FOR IT TWICE. `wrangler r2 object put`
# defaults to a **local simulated bucket**. It prints "Upload complete", a
# following `wrangler r2 object get` reads the file back happily, and nothing
# has left the machine; the public URL 404s. `--remote` is the fix. Nothing in
# this script uses wrangler -- rclone and the `aws` CLI talk to the S3 endpoint
# directly and have no local mode -- and that is one of the reasons it does not.
# `wrangler r2 bucket info`'s `object_count` is also a lagging aggregate and
# reads 0 after a confirmed upload, so **the verification below fetches the
# public URL**, which is what a player does anyway.
#
# Usage:
#   scripts/publish-world-r2.sh [--dry-run] [--hex <id>] [--stamp-only] [--verify]

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORLD="$ROOT/client/public/world"

# Not a secret: it is the hostname of the S3 endpoint and appears in every URL.
R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-b7f27f4a44cf2aea00155a84949b3879}"
R2_BUCKET="${R2_BUCKET:-sydrunner-world}"
R2_ENDPOINT="${R2_ENDPOINT:-https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com}"
# The custom domain on the user's own Cloudflare zone. Deliberately NOT the
# `pub-<hash>.r2.dev` development URL, which Cloudflare rate-limits and
# documents as unsuitable for production.
R2_PUBLIC="${R2_PUBLIC:-https://world.3rp.uk}"

# A year, immutable, for everything the `?v=<built>` suffix covers.
IMMUTABLE="public, max-age=31536000, immutable"
# And the two pivots, which name the version everything else is cached under and
# therefore cannot be cached behind it. See `client/src/world/version.ts`.
PIVOT_CACHE="no-cache"

DRY=""
HEX=""
STAMP_ONLY=""
VERIFY_ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --hex) HEX="${2:?--hex needs a hex id, e.g. h-01+01}"; shift ;;
    --stamp-only) STAMP_ONLY=1 ;;
    --verify) VERIFY_ONLY=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v python3 >/dev/null || { echo "python3 not installed" >&2; exit 1; }
[ -f "$WORLD/index.json" ] || { echo "no index.json in $WORLD" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Credentials, sourced but never echoed. `set -a` exports what the file sets so
# rclone and aws both see them without this script naming the values.
SECRETS="${SYDNEY_SECRETS:-/etc/sydney/secrets.env}"
if [ -f "$SECRETS" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS"
  set +a
fi

# ---------------------------------------------------------------------------
# Verify: fetch the public URL, which is the only success check that means
# anything. See the wrangler note in the header.
verify() {
  probe="$1"
  url="$R2_PUBLIC/$probe"
  echo "verifying $url"
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H 'Origin: https://oxford-tractor.bnr.la' "$url" || echo 000)
  if [ "$code" != "200" ]; then
    echo "  FAIL: $probe returned $code from $R2_PUBLIC" >&2
    return 1
  fi
  cors=$(curl -sSI -H 'Origin: https://oxford-tractor.bnr.la' "$url" |
           tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')
  echo "  200, access-control-allow-origin: ${cors:-<absent>}"
  [ -n "$cors" ] || { echo "  FAIL: no CORS header -- the browser cannot read this" >&2; return 1; }
  return 0
}

if [ -n "$VERIFY_ONLY" ]; then
  verify "root.json"
  verify "suburbs.json"
  exit 0
fi

# ---------------------------------------------------------------------------
# Stamp. The `cdn` block goes into the two pivots on the ORIGIN, which is where
# the client always reads them from -- `vite build` copies `public/` into
# `dist/`, so stamping `public/` covers any future build and `dist/` is stamped
# too when it exists so an already-built tree needs no rebuild.
#
# Both files are stamped identically: `root.json` is what a segmented client
# boots from and `index.json` is what an older one does, and a world served half
# from R2 and half from jsDelivr is the one state neither of them should be able
# to reach.
stamp() {
  [ -f "$1" ] || return 0
  python3 - "$1" "$R2_PUBLIC" <<'PY'
import json, sys
path, base = sys.argv[1], sys.argv[2]
with open(path) as f:
    index = json.load(f)
index["cdn"] = {"base": base}
with open(path, "w") as f:
    json.dump(index, f, separators=(", ", ": "))
PY
  echo "  stamped $1"
}

if [ -n "$STAMP_ONLY" ]; then
  echo "stamping the cdn block -> $R2_PUBLIC"
  stamp "$WORLD/index.json"
  stamp "$WORLD/root.json"
  stamp "$ROOT/client/dist/world/index.json"
  stamp "$ROOT/client/dist/world/root.json"
  exit 0
fi

# ---------------------------------------------------------------------------
# The file list. World-relative paths, one per line, which is what rclone's
# `--files-from` wants and what makes `--hex` exact.
#
# A hexagon owns its tiles' payloads (`tiles/<key>.*`, `collision/<key>.bin`),
# the region bundles whose centres fall in it, and its own three manifests. The
# whole-world files -- the pivots, the suburb table, the far ground and water,
# the landmarks, and the legacy `far.bin` / `street-names.bin` that an older
# client still asks for -- are the "shared" set and go with every publish,
# because they are 8 MB in total and a hexagon published against a stale root
# index is a hexagon no client can find.
LIST="${TMPDIR:-/tmp}/sydney-r2-files.$$"
PIVOTS="${TMPDIR:-/tmp}/sydney-r2-pivots.$$"
trap 'rm -f "$LIST" "$PIVOTS"' EXIT

python3 - "$WORLD" "$HEX" "$LIST" "$PIVOTS" <<'PY'
import json, os, sys
from pathlib import Path

world, hex_id, list_path, pivot_path = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]

# The two files that must never be cached behind the version they name.
pivots = [p for p in ("index.json", "root.json") if (world / p).exists()]

shared = [
    p for p in (
        "suburbs.json", "far.bin", "far-terrain.bin", "far-water.bin",
        "landmarks.glb", "street-names.bin",
    ) if (world / p).exists()
]

def tile_files(keys):
    out = []
    for key in keys:
        for path in world.glob(f"tiles/{key}.*"):
            out.append(f"tiles/{path.name}")
        if (world / f"collision/{key}.bin").exists():
            out.append(f"collision/{key}.bin")
    return out

files = list(shared)
root = world / "root.json"
if hex_id:
    if not root.exists():
        sys.exit("--hex needs root.json: run `uv run python -m sydney hex-pack` first")
    manifest_path = world / "hexes" / f"{hex_id}.json"
    if not manifest_path.exists():
        sys.exit(f"no manifest for {hex_id} at {manifest_path}")
    manifest = json.loads(manifest_path.read_text())
    files += tile_files(e["key"] for e in manifest["tiles"])
    files += [f"regions/{e['key']}.bin" for e in manifest["regions"]
              if (world / f"regions/{e['key']}.bin").exists()]
    for suffix in (".json", ".names.bin", ".far.bin"):
        if (world / "hexes" / f"{hex_id}{suffix}").exists():
            files.append(f"hexes/{hex_id}{suffix}")
else:
    for directory in ("tiles", "collision", "regions", "hexes"):
        base = world / directory
        if not base.is_dir():
            continue
        for path in sorted(base.iterdir()):
            if path.is_file() and not path.name.startswith("."):
                files.append(f"{directory}/{path.name}")

files = sorted(set(files))
Path(list_path).write_text("\n".join(files) + "\n")
Path(pivot_path).write_text("\n".join(pivots) + "\n")

size = sum((world / f).stat().st_size for f in files)
print(f"{len(files):,} objects, {size / 1e9:.2f} GB" + (f"  (hex {hex_id})" if hex_id else ""))
PY

FILES=$(grep -c . "$LIST" || true)
echo "world    $WORLD"
echo "bucket   $R2_BUCKET  ($R2_ENDPOINT)"
echo "public   $R2_PUBLIC"
[ -n "$HEX" ] && echo "segment  $HEX"

# ---------------------------------------------------------------------------
# The tool. rclone if it is here, `aws` if it is not.
#
# rclone is the right one and is worth installing (`brew install rclone`): it
# uploads in parallel, compares by checksum so an unchanged object is not
# re-sent, resumes, and takes `--files-from` -- which is what makes `--hex`
# exact rather than a directory prefix. At ~30,000 objects today and ~300,000 at
# 60 km, the difference between a checksum sync and a re-upload is the
# difference between minutes and an afternoon.
#
# The `aws` CLI is the fallback because it is already installed. It has no
# file-list mode, so it syncs whole directories; `--hex` is refused rather than
# silently ignored.
if command -v rclone >/dev/null 2>&1; then
  TOOL=rclone
elif command -v aws >/dev/null 2>&1; then
  TOOL=aws
else
  echo "neither rclone nor aws is installed. brew install rclone" >&2
  exit 1
fi
echo "tool     $TOOL"

if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ]; then
  echo >&2
  echo "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are not set." >&2
  echo "Put them in $SECRETS (mode 0600) or export them for this shell." >&2
  echo "They are an R2 API token with Object Read & Write on $R2_BUCKET only." >&2
  [ -n "$DRY" ] || exit 1
fi

if [ -n "$DRY" ]; then
  echo
  echo "dry run: would upload $FILES objects to $R2_BUCKET with $TOOL"
  echo "  payload  Cache-Control: $IMMUTABLE"
  echo "  pivots   Cache-Control: $PIVOT_CACHE  ($(tr '\n' ' ' < "$PIVOTS"))"
  echo "  then stamp the cdn block and verify $R2_PUBLIC/root.json"
  head -3 "$LIST" | sed 's/^/  e.g. /'
  exit 0
fi

case "$TOOL" in
  rclone)
    # Configured entirely from the environment, so there is no rclone.conf to
    # keep in sync and no file on disk with a secret in it. `no_check_bucket`
    # skips a CreateBucket probe the token is deliberately not allowed to make.
    export RCLONE_CONFIG_R2_TYPE=s3
    export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
    export RCLONE_CONFIG_R2_ENV_AUTH=false
    export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
    export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
    export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
    export RCLONE_CONFIG_R2_REGION=auto
    export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
    # R2 does not implement multipart ETags as MD5, so `--checksum` alone would
    # re-upload everything over 5 MB every run. Size-and-modtime is what rclone
    # recommends for R2 and is what makes a re-publish of an unchanged world
    # transfer nothing.
    echo
    echo "uploading $FILES objects..."
    rclone copy "$WORLD" "R2:$R2_BUCKET" \
      --files-from "$LIST" \
      --transfers 32 --checkers 32 \
      --s3-chunk-size 32M --s3-upload-concurrency 4 \
      --header-upload "Cache-Control: $IMMUTABLE" \
      --stats 10s --stats-one-line
    # The pivots last and with their own header. Last because they are what
    # names the build: a client that read a new root index against a half-
    # uploaded world would ask for objects that are not there yet.
    echo "uploading the pivots..."
    rclone copy "$WORLD" "R2:$R2_BUCKET" \
      --files-from "$PIVOTS" \
      --header-upload "Cache-Control: $PIVOT_CACHE"
    ;;
  aws)
    if [ -n "$HEX" ]; then
      echo >&2
      echo "--hex needs rclone: the aws CLI has no file-list mode and can only" >&2
      echo "sync whole directories. brew install rclone" >&2
      exit 1
    fi
    export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
    export AWS_DEFAULT_REGION=auto
    # R2 rejects the streaming-payload checksums newer aws CLIs send by default.
    export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
    export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
    echo
    for dir in tiles collision regions hexes; do
      [ -d "$WORLD/$dir" ] || continue
      echo "syncing $dir/..."
      aws s3 sync "$WORLD/$dir" "s3://$R2_BUCKET/$dir" \
        --endpoint-url "$R2_ENDPOINT" \
        --cache-control "$IMMUTABLE" \
        --only-show-errors
    done
    echo "syncing the whole-world files..."
    aws s3 sync "$WORLD" "s3://$R2_BUCKET" \
      --endpoint-url "$R2_ENDPOINT" \
      --cache-control "$IMMUTABLE" \
      --exclude "*/*" --exclude "index.json" --exclude "root.json" \
      --only-show-errors
    echo "uploading the pivots..."
    while read -r pivot; do
      [ -n "$pivot" ] || continue
      aws s3 cp "$WORLD/$pivot" "s3://$R2_BUCKET/$pivot" \
        --endpoint-url "$R2_ENDPOINT" \
        --cache-control "$PIVOT_CACHE" \
        --content-type application/json \
        --only-show-errors
    done < "$PIVOTS"
    ;;
esac

# ---------------------------------------------------------------------------
# Stamp the origin, then prove the CDN answers. In that order: the stamp is what
# sends players at R2, so it should not be written until the objects are there.
echo
echo "stamping index.json and root.json -> $R2_PUBLIC"
stamp "$WORLD/index.json"
stamp "$WORLD/root.json"
stamp "$ROOT/client/dist/world/index.json"
stamp "$ROOT/client/dist/world/root.json"

echo
verify "suburbs.json"
verify "root.json"

echo
echo "bucket   $R2_BUCKET"
echo "objects  $FILES"
echo "url      $R2_PUBLIC/<path>"
echo
echo "The stamp is on the origin's index.json and root.json; deploy them for"
echo "players to start reading from R2. scripts/publish-world.sh still works and"
echo "still stamps the jsDelivr block -- whichever ran last is where players go."
