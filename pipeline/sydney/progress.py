"""Live build progress, written to one small JSON file for anything to read.

WHY. A build is long and, until now, silent between its phase headers -- "reading
the terrain" and then nothing for the best part of three hours, then a tile bar
only a TTY ever saw. This writes a snapshot to a fixed path on every phase change
and every 0.1% of the phase that carries the tiles, so a watcher -- the live
dashboard in `scripts/build-watch.py`, or a plain `tail` -- can show where a bake
is without scraping stdout or counting files on disk.

THE BAR SPANS THE WHOLE BUILD. Each macro-phase owns a slice of the overall
percentage, weighted by its share of the wall-clock on a measured cached-head
middle round: the emit is most of the time, so it is most of the bar. The weights
are deliberately rough -- a progress bar's job is to be monotonic and
roughly-right, not exact -- and the overall percentage only ever moves forward.

CHEAP AND ROBUST. One throttled atomic write (tmp + os.replace), so a reader never
catches a half-written file and the build never pays for a write it does not need.
Failing to write progress must never fail a build, so every write is guarded.
"""

from __future__ import annotations

import json
import os
import time

from . import config

PROGRESS_PATH = config.DATA_ROOT / "build-progress.json"

# Macro-phase -> fraction of the overall bar. Rough wall-clock shares; they need
# only sum to 1 and rank right. `emit` dominates because it is the long pole once
# the head is cached.
_ORDER = ["head", "emit", "regions", "finalize"]
_WEIGHTS = {"head": 0.15, "emit": 0.65, "regions": 0.15, "finalize": 0.05}

# Write at most this often by time, and at least this fine by fraction: every
# 0.1% of a phase, or every half second, whichever comes first.
_MIN_STEP = 0.001
_MIN_INTERVAL_S = 0.5

_state: dict = {}


def _weight_before(name: str) -> float:
    return sum(_WEIGHTS[p] for p in _ORDER[: _ORDER.index(name)])


def _overall(name: str, frac: float) -> float:
    return _weight_before(name) + _WEIGHTS[name] * max(0.0, min(1.0, frac))


def _write(force: bool = False) -> None:
    now = time.time()
    if not force:
        moved = _state["frac"] - _state.get("last_frac", -1.0)
        elapsed = now - _state.get("last_write", 0.0)
        if moved < _MIN_STEP and elapsed < _MIN_INTERVAL_S:
            return
    _state["last_frac"] = _state["frac"]
    _state["last_write"] = now

    started = _state["started"]
    overall = _state["overall"]
    wall = now - started
    # Overall ETA from how far the whole bar has moved; phase ETA from the phase's
    # own rate. Both are best-effort and only shown once there is signal.
    overall_eta = (wall / overall - wall) if overall > 0.01 else None
    total = _state.get("total", 0)
    done = _state.get("done", 0)
    phase_wall = now - _state.get("phase_started", now)
    phase_eta = None
    if total and done and phase_wall > 0:
        phase_eta = (total - done) * (phase_wall / done)

    snapshot = {
        "overall_pct": round(100 * overall, 3),
        "phase": _state["phase"],
        "phase_index": _ORDER.index(_state["phase"]) + 1,
        "phase_count": len(_ORDER),
        "phase_pct": round(100 * _state["frac"], 2),
        "done": done,
        "total": total,
        "message": _state.get("message", ""),
        "rate_per_s": round(done / phase_wall, 2) if (done and phase_wall > 0) else None,
        "phase_eta_s": round(phase_eta) if phase_eta is not None else None,
        "overall_eta_s": round(overall_eta) if overall_eta is not None else None,
        "elapsed_s": round(wall),
        "started_at": started,
        "updated_at": now,
        "done_flag": _state.get("done_flag", False),
    }
    try:
        PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = PROGRESS_PATH.with_suffix(".json.tmp")
        with open(tmp, "w") as f:
            json.dump(snapshot, f)
        os.replace(tmp, PROGRESS_PATH)
    except Exception:  # noqa: BLE001 -- progress must never break a build
        pass


def begin(label: str = "") -> None:
    _state.clear()
    _state.update(
        started=time.time(),
        phase="head",
        frac=0.0,
        overall=0.0,
        done=0,
        total=0,
        message=label or "starting",
        phase_started=time.time(),
        done_flag=False,
    )
    _write(force=True)


def phase(name: str, total: int = 0, message: str = "") -> None:
    """Enter a macro-phase. `total` sets the unit count for a counted phase (the
    emit, the regions); a phase with no total shows only its message and moves in
    coarse steps via `step`."""
    if not _state:
        begin()
    _state.update(
        phase=name,
        total=total,
        done=0,
        frac=0.0,
        message=message,
        phase_started=time.time(),
    )
    _state["overall"] = _overall(name, 0.0)
    _write(force=True)


def tick(n: int = 1, message: str | None = None) -> None:
    """Advance a counted phase by `n` units. Throttled to every 0.1% or 0.5 s."""
    if not _state:
        return
    _state["done"] += n
    if message is not None:
        _state["message"] = message
    total = _state.get("total", 0)
    _state["frac"] = (_state["done"] / total) if total else 0.0
    _state["overall"] = _overall(_state["phase"], _state["frac"])
    _write()


def step(frac: float, message: str = "") -> None:
    """Set a coarse phase fraction directly, for a phase with no unit count (the
    head's discrete stages). `frac` is 0..1 within the phase."""
    if not _state:
        return
    _state["frac"] = max(0.0, min(1.0, frac))
    if message:
        _state["message"] = message
    _state["overall"] = _overall(_state["phase"], _state["frac"])
    _write()


def done(message: str = "done") -> None:
    if not _state:
        return
    _state.update(phase="finalize", frac=1.0, overall=1.0, message=message, done_flag=True)
    _write(force=True)
