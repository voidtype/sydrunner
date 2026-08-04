"""SQLite job ledger.

The spec's requirement: "if it dies on tile 4,000 of 12,000 it resumes at 4,000".
Every unit of work in the pipeline is a row here, keyed by (stage, kind, key).
Nothing re-does work that is already marked done, and a crashed unit is left
`running` with its error recorded so a resume can retry it specifically.
"""

from __future__ import annotations

import contextlib
import sqlite3
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    kind        TEXT NOT NULL,   -- 'footprints' | 'lidar' | 'facade' | 'tile' ...
    key         TEXT NOT NULL,   -- quadkey, tile id, whatever addresses the unit
    state       TEXT NOT NULL,   -- 'pending' | 'running' | 'done' | 'failed' | 'empty'
    attempts    INTEGER NOT NULL DEFAULT 0,
    started_at  REAL,
    finished_at REAL,
    error       TEXT,
    detail      TEXT,            -- free-form JSON, e.g. counts
    PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS jobs_by_state ON jobs (kind, state);

-- Per-building attribute records survive between runs so that a facade or tile
-- rebuild does not require re-downloading and re-joining every source.
CREATE TABLE IF NOT EXISTS buildings (
    id            TEXT PRIMARY KEY,  -- stable, derived from footprint geometry
    tile          TEXT NOT NULL,
    east          REAL NOT NULL,     -- centroid, local ENU metres
    north         REAL NOT NULL,
    area          REAL NOT NULL,     -- footprint m^2
    height        REAL,              -- metres, LiDAR P99 when available
    height_source TEXT,              -- 'lidar' | 'osm_levels' | 'inferred'
    levels        INTEGER,
    roof_form     TEXT,
    roof_height   REAL,
    archetype     TEXT,
    material      TEXT,
    retail        INTEGER NOT NULL DEFAULT 0,
    start_date    TEXT,
    geometry      TEXT NOT NULL      -- ENU ring(s) as JSON
);
CREATE INDEX IF NOT EXISTS buildings_by_tile ON buildings (tile);
"""


def connect(path: Path | None = None) -> sqlite3.Connection:
    p = path or config.LEDGER_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(p, timeout=60.0)
    con.row_factory = sqlite3.Row
    # WAL so a long-running writer does not block the read-only status queries.
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.executescript(SCHEMA)
    return con


def register(con: sqlite3.Connection, kind: str, keys: list[str]) -> int:
    """Declare units of work. Existing rows keep their state -- this is what
    makes calling the pipeline twice safe. Returns the number newly added."""
    before = con.total_changes
    con.executemany(
        "INSERT OR IGNORE INTO jobs (kind, key, state) VALUES (?, ?, 'pending')",
        [(kind, k) for k in keys],
    )
    con.commit()
    return con.total_changes - before


def pending(con: sqlite3.Connection, kind: str, retry_failed: bool = True) -> list[str]:
    """Keys still needing work, in insertion order.

    `running` rows are included: the only way a row is left running is a crash,
    so on a resume they are exactly the work that was interrupted.
    """
    states = ["pending", "running"]
    if retry_failed:
        states.append("failed")
    q = f"SELECT key FROM jobs WHERE kind = ? AND state IN ({','.join('?' * len(states))}) ORDER BY rowid"
    return [r["key"] for r in con.execute(q, [kind, *states])]


def counts(con: sqlite3.Connection, kind: str | None = None) -> dict[str, dict[str, int]]:
    q = "SELECT kind, state, COUNT(*) n FROM jobs"
    args: list[Any] = []
    if kind:
        q += " WHERE kind = ?"
        args.append(kind)
    q += " GROUP BY kind, state"
    out: dict[str, dict[str, int]] = {}
    for r in con.execute(q, args):
        out.setdefault(r["kind"], {})[r["state"]] = r["n"]
    return out


@contextlib.contextmanager
def unit(con: sqlite3.Connection, kind: str, key: str) -> Iterator[dict[str, Any]]:
    """Run one unit of work, recording its outcome either way.

    Yields a mutable dict; whatever the body puts in it is stored as `detail`.
    Set `detail['empty'] = True` for a unit that legitimately produced nothing
    (an ocean tile, say) so it is not retried forever.
    """
    con.execute(
        "UPDATE jobs SET state='running', attempts=attempts+1, started_at=?, error=NULL"
        " WHERE kind=? AND key=?",
        (time.time(), kind, key),
    )
    con.commit()
    detail: dict[str, Any] = {}
    try:
        yield detail
    except Exception as exc:  # noqa: BLE001 -- recorded, then re-raised
        con.execute(
            "UPDATE jobs SET state='failed', finished_at=?, error=? WHERE kind=? AND key=?",
            (time.time(), f"{type(exc).__name__}: {exc}"[:2000], kind, key),
        )
        con.commit()
        raise
    else:
        import json

        state = "empty" if detail.pop("empty", False) else "done"
        con.execute(
            "UPDATE jobs SET state=?, finished_at=?, detail=?, error=NULL WHERE kind=? AND key=?",
            (state, time.time(), json.dumps(detail) if detail else None, kind, key),
        )
        con.commit()


def reset(con: sqlite3.Connection, kind: str) -> int:
    """Force a whole stage to re-run. Used when the code that produces it changes."""
    cur = con.execute("UPDATE jobs SET state='pending', error=NULL WHERE kind=?", (kind,))
    con.commit()
    return cur.rowcount
