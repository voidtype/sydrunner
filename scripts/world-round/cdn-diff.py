#!/usr/bin/env python3
"""Which world files differ from what the CDN is serving, by content.

WHY THIS EXISTS. `DEPLOY.md` §B step 1 says to snapshot the world before a
retile so the upload can send only what changed. That is the right procedure and
it only works if somebody remembers. This is the recovery when nobody did, and it
is strictly better evidence than the snapshot was: it compares against **what is
actually being served** rather than against what we think we last sent.

It works because R2 sets an object's ETag to the MD5 of its content for any
single-part upload, and every file in this world is far under the multipart
threshold. So `curl -I` against the public bucket returns, for free and without
credentials, exactly the hash needed to decide whether a byte moved. Verified
before the first use: `tiles/0_0.terr.bin` etag `5bd86cc8...` equals the local
`md5 -q` of the same file.

It is also the answer to a rolled S3 token. `publish-world-r2.sh` syncs by
checksum through rclone and needs Object Read & Write; when that pair is dead the
documented fallback is per-object `wrangler --remote`, which has no sync mode at
all -- so the diff has to come from somewhere, and the somewhere is here.

Prints one key per line to stdout (the upload list) and a summary to stderr, so

    cdn-diff.py --world client/public/world > changed.txt

is the whole of the interface. `--limit` samples rather than walking everything,
which is what to use when the question is "did terrain move" rather than "what do
I upload".
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# Files that are never objects in the bucket.
SKIP_SUFFIX = (".br", ".zst", ".gz", ".DS_Store")
SKIP_NAME = {".DS_Store"}


def md5_of(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def remote_etag(base: str, key: str, timeout: float) -> str | None:
    req = urllib.request.Request(f"{base}/{key}", method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            tag = r.headers.get("ETag", "")
            return tag.strip('"') or None
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", default="client/public/world")
    ap.add_argument("--base", default="https://world.3rp.uk")
    ap.add_argument("--jobs", type=int, default=64)
    ap.add_argument("--timeout", type=float, default=20.0)
    ap.add_argument("--limit", type=int, default=0, help="sample this many keys, evenly spread")
    ap.add_argument("--prefix", default="", help="only keys starting with this")
    args = ap.parse_args()

    root = Path(args.world)
    keys: list[str] = []
    for dirpath, _dirs, files in os.walk(root):
        for name in sorted(files):
            if name in SKIP_NAME or name.endswith(SKIP_SUFFIX):
                continue
            key = str(Path(dirpath, name).relative_to(root))
            if args.prefix and not key.startswith(args.prefix):
                continue
            keys.append(key)
    keys.sort()
    if args.limit and args.limit < len(keys):
        stride = len(keys) / args.limit
        keys = [keys[int(i * stride)] for i in range(args.limit)]

    print(f"{len(keys):,} keys under {root}", file=sys.stderr)
    lock = threading.Lock()
    changed: list[str] = []
    absent: list[str] = []
    same = 0
    done = 0

    def one(key: str) -> None:
        nonlocal same, done
        local = md5_of(root / key)
        tag = remote_etag(args.base, key, args.timeout)
        with lock:
            done += 1
            if tag is None:
                absent.append(key)
            elif tag != local:
                changed.append(key)
            else:
                same += 1
            if done % 5000 == 0:
                print(
                    f"  {done:,}/{len(keys):,}  same {same:,}  changed {len(changed):,}"
                    f"  absent {len(absent):,}",
                    file=sys.stderr,
                )

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        list(pool.map(one, keys))

    for key in sorted(changed) + sorted(absent):
        print(key)
    print(
        f"same {same:,}   changed {len(changed):,}   not on the CDN {len(absent):,}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
