"""Put back the mtime of every region bundle whose bytes did not change.

`cli._emit_regions` repacks EVERY region bundle on every run -- 5,302 of them,
5.7 GB -- because "a region is whatever its tiles are made of at the moment it
is packed" and doing it every run is what guarantees the bundles match the index
beside them. That is right, and it is also why a 382-tile retile leaves 5,302
files with a fresh mtime and (almost all of them) identical contents.

`publish-world-r2.sh` uploads with rclone, which decides what to send from size
and modtime. Without this, a 382-tile round would push several GB of unchanged
bundles to R2 for nothing. So: hash them before the build (`regions-before.json`),
hash them after, and `os.utime` the ones that match back to the timestamp they
had. A bundle whose bytes actually changed keeps its new mtime and is uploaded.

Two modes. `--snapshot` writes the before-file by hashing **every** region bundle
on disk, not only the ones inside the hexagons being published: the next partial
retile may touch any hexagon, and a before-file that only covers the last round's
hexagons cannot tell a changed bundle from an unchanged one anywhere else. The
default mode reads the before-file and restores the mtime of every bundle whose
bytes still match, so a size-and-mtime uploader sends only the ones that did.

Used for the 2026-08-17 station round (382 tiles, 36 hexagons); promoted from
`data/scratch/station-round/` so the next partial retile does not rediscover it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WORLD = ROOT / "client" / "public" / "world"
DEFAULT_BEFORE = ROOT / "data" / "scratch" / "station-round" / "regions-before.json"


def _hash(p: Path) -> tuple[str, int, float]:
    b = p.read_bytes()
    return hashlib.sha1(b).hexdigest(), len(b), os.path.getmtime(p)


def snapshot(world: Path, before: Path) -> None:
    """Hash every region bundle on disk and write the before-file.

    All of them, not only the hexagons this round publishes: a before-file that
    covers only the last round's hexagons cannot tell a changed bundle from an
    unchanged one in any other hexagon, and the next partial retile may touch any
    of them.
    """
    regions = world / "regions"
    out: dict[str, list] = {}
    for p in sorted(regions.glob("*.bin")):
        sha, size, mtime = _hash(p)
        out[p.stem] = [sha, size, mtime]
    before.write_text(json.dumps(out))
    print(f"{len(out):,} region bundles hashed -> {before}")


def restore(world: Path, before: Path) -> None:
    """Put back the mtime of every region bundle whose bytes did not change."""
    data = json.loads(before.read_text())
    restored = changed = gone = 0
    changed_keys: list[str] = []
    for key, (sha, size, mtime) in data.items():
        p = world / "regions" / f"{key}.bin"
        if not p.is_file():
            gone += 1
            continue
        b = p.read_bytes()
        if hashlib.sha1(b).hexdigest() == sha:
            os.utime(p, (mtime, mtime))
            restored += 1
        else:
            changed += 1
            changed_keys.append(key)

    print(f"{restored:,} region bundles byte-identical -- mtime restored, rclone will skip them")
    print(f"{changed:,} genuinely changed and will be uploaded")
    print(f"{gone:,} named in the before-snapshot and no longer on disk")
    for k in sorted(changed_keys)[:30]:
        print(f"    regions/{k}.bin")
    if len(changed_keys) > 30:
        print(f"    ... and {len(changed_keys) - 30:,} more")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--before", default=str(DEFAULT_BEFORE),
                    help="the before-snapshot json (default: the station round's)")
    ap.add_argument("--world", default=str(DEFAULT_WORLD),
                    help="the world directory holding regions/ (default: client/public/world)")
    ap.add_argument("--snapshot", action="store_true",
                    help="hash every region bundle and write the before-file, instead of "
                    "reading it and restoring mtimes")
    args = ap.parse_args()
    world = Path(args.world)
    before = Path(args.before)
    if args.snapshot:
        snapshot(world, before)
    else:
        restore(world, before)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
