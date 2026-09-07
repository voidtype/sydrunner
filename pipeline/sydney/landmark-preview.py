"""Write the hero landmark set alone, so `landmark-audit` can be run on a solve.

`sydney landmark-audit` reads the *shipped* world -- `index.json` and
`landmarks.glb` under `config.OUT_ROOT` -- which means that until now the only
way to ask it anything about a terrain change was to build the world first. That
is hours for a question whose whole input is four parametric models and one
`Terrain`, and it is the reason a terrain rule aimed squarely at Luna Park could
be argued about but not audited.

So this writes exactly the two files the audit opens, into a directory of your
choosing, and nothing else:

    cd pipeline
    SYDNEY_WORLD_OUT=/tmp/lm-on  PYTHONPATH=. uv run python sydney/landmark-preview.py
    SYDNEY_WORLD_OUT=/tmp/lm-off PYTHONPATH=. uv run python sydney/landmark-preview.py --no-pads
    SYDNEY_WORLD_OUT=/tmp/lm-on  PYTHONPATH=. uv run python -m sydney landmark-audit

`SYDNEY_WORLD_OUT` is `config.OUT_ROOT`'s own override and is what keeps this
away from `client/public/world`; **set it, or this writes into the real world
directory.** Run it twice, once each way, and diff the two audits: that diff is
the honest statement of what a terrain change did to the landmarks, and for
`pads.py` it is empty for the bridge, the Opera House and Sydney Tower.

ONE FAILURE IS THIS HARNESS AND NOT THE WORLD, and it is worth naming so nobody
chases it: `landmark-audit` reports *"the bridge deck's collision is in 0
pieces"*, because the deck's collision prisms live in the tile payload and no
tile is emitted here. It reports it identically with the rules on and off, which
is what makes it safe to read past.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sydney import config, landmarks, terraincache, tiles


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--radius", type=float, default=config.STAGE_BY_NAME["inner"].radius_m)
    ap.add_argument("--no-pads", action="store_true",
                    help="solve the terrain with `pads.py` off, for the before column")
    args = ap.parse_args(argv)

    out = config.OUT_ROOT
    if out == Path(__file__).resolve().parents[2] / "client" / "public" / "world":
        raise SystemExit(
            "refusing to write into the real world directory. "
            "Set SYDNEY_WORLD_OUT to a scratch path first."
        )
    out.mkdir(parents=True, exist_ok=True)

    terrain = terraincache.load(args.radius, conform_pads=not args.no_pads)
    anchor_radius = min(args.radius, 4000.0)
    landmarks.read_podium_ring(anchor_radius)
    anchors = landmarks.read_anchors(anchor_radius)
    marks = landmarks.build_all(terrain, anchors)
    stats = tiles.write_landmarks(out / "landmarks.glb", marks)
    (out / "index.json").write_text(
        json.dumps(
            {
                "radius_m": anchor_radius,
                "landmarks": {
                    **landmarks.manifest(marks, anchors, terrain),
                    "bytes": stats["bytes"],
                },
            },
            indent=1,
        )
    )
    print(f"  wrote {out}/landmarks.glb ({stats['triangles']:,} triangles) and index.json")
    for m in marks:
        nums = {k: round(v, 3) for k, v in m.audit.items() if isinstance(v, (int, float))}
        print(f"  {m.name:<16} {nums}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
