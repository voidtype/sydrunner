#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "requests>=2.32",
#     "pdfplumber>=0.11",
# ]
# ///
"""Download and extract Transport for NSW "Station CAD Drawings" PDFs.

Standalone, idempotent, resumable. Talks to nothing under client/, server/,
or pipeline/ -- it writes cached PDFs under data/cache/station-cad/ and
extracted JSON under data/scratch/stationcad/.

Usage (all via `uv run scripts/stationcad.py <step>`, or just run this file
directly -- it is a PEP 723 script and `uv` resolves its own deps):

    uv run scripts/stationcad.py enumerate   # hit the CKAN API, write manifest.json
    uv run scripts/stationcad.py download    # fetch every PDF into the cache
    uv run scripts/stationcad.py extract     # parse every cached PDF to JSON
    uv run scripts/stationcad.py summarize   # write summary.json + REPORT.md
    uv run scripts/stationcad.py all         # the four steps in order

Each step re-reads what the previous step wrote and skips work already done,
so re-running the whole pipeline after an interruption just fills in gaps.
(`extract --force` re-parses sheets that already have JSON; needed after any
change to what extraction writes.)

COORDINATE SPACE -- one definition, many readers. Every coordinate in the
emitted JSON is native PDF page space: origin at the MediaBox bottom-left,
x right, y UP, units PDF points. That covers text `x`/`y`, text `bbox`, path
`points`, and the document `bbox`. pdfplumber does not present it that way --
char matrices are PDF space but path `pts` are its display space, y down from
the page top -- so `_extract_paths` flips the paths once, here, and nothing
downstream flips anything. Before 2026-08-12 this file wrote both conventions
side by side and the document `bbox` mixed them and meant nothing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = REPO_ROOT / "data" / "cache" / "station-cad"
SCRATCH_DIR = REPO_ROOT / "data" / "scratch" / "stationcad"
MANIFEST_PATH = CACHE_DIR / "manifest.json"
SUMMARY_PATH = SCRATCH_DIR / "summary.json"
REPORT_PATH = SCRATCH_DIR / "REPORT.md"

CKAN_SEARCH_URL = "https://opendata.transport.nsw.gov.au/api/3/action/package_search"
CKAN_QUERY = "station cad drawings"

# The seven alphabetic-range datasets that carry per-station drawings. The
# search also turns up "train-station-plans" and "northconnex", which are a
# different kind of document (not per-station CAD sheets) -- excluded per
# spec.
TARGET_DATASETS = {
    "station-cad-drawings-c",
    "station-cad-drawings-d-g",
    "station-cad-drawings-h-l",
    "station-cad-drawings-m-o",
    "station-cad-drawings-p-r",
    "station-cad-drawings-s-v",
    "station-cad-drawings-w-z",
}

USER_AGENT = "sydrunner-stationcad-extractor/1.0 (mechanical data extraction; contact via github.com/voidtype)"


def slugify(station_name: str) -> str:
    """'Macdonaldtown Station' -> 'macdonaldtown'; 'East Hills' -> 'east-hills'."""
    s = re.sub(r"\bStation\b", "", station_name, flags=re.I).strip()
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()
    return s


# --------------------------------------------------------------------------
# Step 1a: enumerate
# --------------------------------------------------------------------------


def cmd_enumerate(args: argparse.Namespace) -> None:
    if MANIFEST_PATH.exists() and not args.refresh:
        print(f"manifest already exists at {MANIFEST_PATH} (use --refresh to re-query CKAN)")
        return

    print(f"querying CKAN: {CKAN_SEARCH_URL}?q={CKAN_QUERY!r}&rows=50")
    resp = requests.get(
        CKAN_SEARCH_URL,
        params={"q": CKAN_QUERY, "rows": 50},
        headers={"User-Agent": USER_AGENT},
        timeout=30,
    )
    resp.raise_for_status()
    payload = resp.json()
    if not payload.get("success"):
        print("CKAN API returned success=false -- STOPPING, not improvising.", file=sys.stderr)
        print(json.dumps(payload, indent=2)[:2000], file=sys.stderr)
        sys.exit(1)

    packages = payload["result"]["results"]
    found_datasets = {p["name"] for p in packages}
    missing = TARGET_DATASETS - found_datasets
    if missing:
        print(
            f"STOPPING: expected datasets not found in CKAN response: {sorted(missing)}\n"
            f"Datasets actually returned: {sorted(found_datasets)}",
            file=sys.stderr,
        )
        sys.exit(1)

    entries: list[dict] = []
    seen_slugs: dict[str, dict] = {}
    skipped_non_pdf = []
    for pkg in packages:
        if pkg["name"] not in TARGET_DATASETS:
            continue
        for res in pkg.get("resources", []):
            fmt = (res.get("format") or "").upper()
            name = (res.get("name") or "").strip()
            if fmt != "PDF":
                skipped_non_pdf.append((pkg["name"], name, fmt))
                continue
            slug = slugify(name)
            entry = {
                "station": name,
                "slug": slug,
                "dataset": pkg["name"],
                "resource_id": res.get("id"),
                "url": res.get("url"),
                "ckan_format": fmt,
            }
            if slug in seen_slugs:
                # Disambiguate real collisions (shouldn't happen given the
                # alphabetic dataset split, but don't silently drop data).
                prior = seen_slugs[slug]
                print(
                    f"WARNING: slug collision {slug!r} between "
                    f"{prior['station']!r} ({prior['dataset']}) and "
                    f"{name!r} ({pkg['name']}) -- disambiguating with resource id suffix",
                    file=sys.stderr,
                )
                entry["slug"] = f"{slug}-{(res.get('id') or '')[:8]}"
            seen_slugs[entry["slug"]] = entry
            entries.append(entry)

    entries.sort(key=lambda e: e["slug"])

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(entries, indent=2) + "\n")
    print(f"wrote {len(entries)} PDF resource entries to {MANIFEST_PATH}")
    if skipped_non_pdf:
        print(f"skipped {len(skipped_non_pdf)} non-PDF resources: {skipped_non_pdf}")


# --------------------------------------------------------------------------
# Step 1b: download
# --------------------------------------------------------------------------


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _download_one(entry: dict, session: requests.Session, retries: int) -> tuple[dict, str | None]:
    """Returns (updated_entry, error_message_or_None)."""
    dest = CACHE_DIR / f"{entry['slug']}.pdf"
    if dest.exists() and dest.stat().st_size > 0:
        entry["byte_size"] = dest.stat().st_size
        entry["sha256"] = sha256_of_file(dest)
        entry["download_status"] = "cached"
        return entry, None

    last_err = None
    for attempt in range(1, retries + 1):
        try:
            r = session.get(entry["url"], headers={"User-Agent": USER_AGENT}, timeout=60)
            r.raise_for_status()
            content = r.content
            if not content:
                raise ValueError("empty response body")
            dest.write_bytes(content)
            entry["byte_size"] = len(content)
            entry["sha256"] = hashlib.sha256(content).hexdigest()
            entry["download_status"] = "downloaded"
            return entry, None
        except Exception as e:  # noqa: BLE001 - want to record and retry any transient failure
            last_err = str(e)
            if attempt < retries:
                time.sleep(1.5 * attempt)
    entry["download_status"] = "failed"
    entry["download_error"] = last_err
    return entry, last_err


def cmd_download(args: argparse.Namespace) -> None:
    if not MANIFEST_PATH.exists():
        print("no manifest.json -- run `enumerate` first", file=sys.stderr)
        sys.exit(1)
    entries = json.loads(MANIFEST_PATH.read_text())
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    errors: list[tuple[str, str]] = []
    done = 0
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {
            pool.submit(_download_one, entry, session, args.retries): entry for entry in entries
        }
        for fut in as_completed(futures):
            entry, err = fut.result()
            done += 1
            status = entry.get("download_status")
            marker = "." if status == "cached" else ("+" if status == "downloaded" else "X")
            print(marker, end="", flush=True)
            if done % 80 == 0:
                print(f"  {done}/{len(entries)}")
            if err:
                errors.append((entry["station"], err))
    print()

    MANIFEST_PATH.write_text(json.dumps(entries, indent=2) + "\n")

    n_cached = sum(1 for e in entries if e.get("download_status") == "cached")
    n_downloaded = sum(1 for e in entries if e.get("download_status") == "downloaded")
    n_failed = sum(1 for e in entries if e.get("download_status") == "failed")
    print(f"cached (already present): {n_cached}")
    print(f"downloaded this run: {n_downloaded}")
    print(f"failed: {n_failed}")
    for name, err in errors:
        print(f"  FAILED {name}: {err}")


# --------------------------------------------------------------------------
# Step 2: extract
# --------------------------------------------------------------------------


def _char_scale(matrix: tuple[float, ...]) -> float:
    a, b = matrix[0], matrix[1]
    return math.hypot(a, b)


def _char_angle(matrix: tuple[float, ...]) -> float:
    a, b = matrix[0], matrix[1]
    return math.degrees(math.atan2(b, a)) % 360


def _group_text_runs(chars: list[dict]) -> list[dict]:
    """Group pdfplumber's per-character records into text runs.

    CAD label text arrives as one glyph per Tj/positioning operator, so
    naive word-boundary heuristics (pdfplumber's own extract_words) fall
    apart on rotated labels. Instead we walk characters in stream order and
    keep extending the current run as long as font, scale and rotation
    match and the next glyph lands where the previous glyph's own advance
    (matrix scale * adv) predicts it should -- which is also how ordinary
    inter-word spaces resolve, since the space glyph carries its own advance.
    A run only breaks where the actual next glyph is somewhere that advance
    doesn't predict, i.e. a genuinely new piece of text.
    """
    runs: list[dict] = []
    cur: dict | None = None
    for ch in chars:
        matrix = ch["matrix"]
        angle = _char_angle(matrix)
        scale = _char_scale(matrix)
        ex, ey = matrix[4], matrix[5]
        merged = False
        if cur is not None:
            angle_diff = abs(((angle - cur["angle"]) + 180) % 360 - 180)
            dx, dy = ex - cur["last_e"], ey - cur["last_f"]
            theta = math.radians(cur["angle"])
            dirx, diry = math.cos(theta), math.sin(theta)
            proj = dx * dirx + dy * diry
            perp = -dx * diry + dy * dirx
            same_font = ch["fontname"] == cur["fontname"]
            expected = cur["last_adv"] * cur["scale"]
            tol = 0.5 * expected + 0.6 * cur["scale"]
            gap_ok = abs(proj - expected) <= tol
            perp_ok = abs(perp) < 0.5 * cur["scale"]
            if same_font and angle_diff < 2.0 and gap_ok and perp_ok:
                cur["chars"].append(ch)
                cur["last_e"], cur["last_f"] = ex, ey
                cur["last_adv"] = ch["adv"]
                cur["scale"] = scale
                merged = True
        if not merged:
            if cur is not None:
                runs.append(cur)
            cur = {
                "chars": [ch],
                "angle": angle,
                "fontname": ch["fontname"],
                "scale": scale,
                "last_e": ex,
                "last_f": ey,
                "last_adv": ch["adv"],
            }
    if cur is not None:
        runs.append(cur)

    out = []
    for r in runs:
        text = "".join(c["text"] for c in r["chars"]).strip()
        if not text:
            continue
        cs = r["chars"]
        x0 = min(c["x0"] for c in cs)
        y0 = min(c["y0"] for c in cs)
        x1 = max(c["x1"] for c in cs)
        y1 = max(c["y1"] for c in cs)
        first = cs[0]["matrix"]
        out.append(
            {
                "text": text,
                "x": round(first[4], 3),
                "y": round(first[5], 3),
                "rotation_deg": round(r["angle"], 2),
                "font": r["fontname"],
                "size": round(sum(c["size"] for c in cs) / len(cs), 3),
                "bbox": [round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)],
            }
        )
    return out


def _extract_paths(page, page_top: float) -> list[dict]:
    """pdfplumber's raw path objects (lines/rects/curves), written y-UP.

    ONE FILE, ONE SPACE. Everything this extractor writes -- text `x`/`y`,
    text `bbox`, path `points`, and the document `bbox` -- is in native PDF
    page space: origin at the MediaBox bottom-left, y increasing UPWARD, the
    space the MediaBox itself and the text glyph matrices are defined in.

    pdfplumber does not hand it over that way. A page object's `pts` are in
    pdfplumber's own display space, y measured DOWNWARD from the top of the
    page, while a char's `matrix` and `y0`/`y1` are PDF space, y up. Writing
    both out untouched -- which is what this file did until 2026-08-12 -- puts
    two vertical conventions in one JSON, makes the combined `bbox`
    meaningless, and leaves every reader to flip the paths itself and to know
    that it has to. So the flip happens exactly once, here, at the source:

        y_pdf = page_top - y_display

    with `page_top` the MediaBox's top edge. `scripts/stationfit/cadgeom.mjs`
    and `scripts/stationfit/render.py` read the result directly.
    """
    out = []
    for kind, objs in (("line", page.lines), ("rect", page.rects), ("curve", page.curves)):
        for obj in objs:
            pts = [[round(x, 3), round(page_top - y, 3)] for x, y in obj["pts"]]
            out.append(
                {
                    "kind": kind,
                    "points": pts,
                    "stroke": bool(obj.get("stroke")),
                    "fill": bool(obj.get("fill")),
                    "linewidth": obj.get("linewidth"),
                }
            )
    return out


def _bbox_of(texts: list[dict], paths: list[dict]) -> list[float] | None:
    """The drawn extent of the sheet, texts and paths together.

    Only means anything because `_extract_paths` has already put the paths in
    the same y-up space the text bboxes are in.
    """
    xs: list[float] = []
    ys: list[float] = []
    for t in texts:
        xs.extend([t["bbox"][0], t["bbox"][2]])
        ys.extend([t["bbox"][1], t["bbox"][3]])
    for p in paths:
        for x, y in p["points"]:
            xs.append(x)
            ys.append(y)
    if not xs:
        return None
    return [round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)]


def extract_one(pdf_path: Path, entry: dict) -> dict:
    import pdfplumber

    with pdfplumber.open(pdf_path) as pdf:
        page_count = len(pdf.pages)
        page = pdf.pages[0]
        mediabox = [round(float(v), 3) for v in page.mediabox]
        texts = _group_text_runs(page.chars)
        paths = _extract_paths(page, page_top=float(page.mediabox[3]))
        n_images = len(page.images)
        extra_pages_info = []
        for i, p in enumerate(pdf.pages[1:], start=2):
            extra_pages_info.append(
                {"page": i, "mediabox": [round(float(v), 3) for v in p.mediabox]}
            )

    return {
        "station": {"name": entry["station"], "slug": entry["slug"]},
        "source": {
            "url": entry["url"],
            "sha256": entry.get("sha256"),
            "page_count": page_count,
            "media_box": mediabox,
            "extra_pages": extra_pages_info,
            "image_count_page1": n_images,
        },
        "texts": texts,
        "paths": paths,
        "bbox": _bbox_of(texts, paths),
    }


def cmd_extract(args: argparse.Namespace) -> None:
    if not MANIFEST_PATH.exists():
        print("no manifest.json -- run `enumerate` and `download` first", file=sys.stderr)
        sys.exit(1)
    entries = json.loads(MANIFEST_PATH.read_text())
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)

    failures: list[dict] = []
    n_ok = 0
    n_skipped = 0
    for i, entry in enumerate(entries, 1):
        slug = entry["slug"]
        pdf_path = CACHE_DIR / f"{slug}.pdf"
        out_path = SCRATCH_DIR / f"{slug}.json"
        if entry.get("download_status") == "failed":
            failures.append({"station": entry["station"], "slug": slug, "error": "download failed, no PDF to parse"})
            continue
        if not pdf_path.exists():
            failures.append({"station": entry["station"], "slug": slug, "error": "PDF not found in cache"})
            continue
        if out_path.exists() and not args.force:
            n_skipped += 1
            continue
        try:
            result = extract_one(pdf_path, entry)
            out_path.write_text(json.dumps(result, indent=2) + "\n")
            n_ok += 1
        except Exception as e:  # noqa: BLE001
            failures.append({"station": entry["station"], "slug": slug, "error": f"{type(e).__name__}: {e}"})
        if i % 40 == 0:
            print(f"  {i}/{len(entries)}")

    print(f"extracted: {n_ok}")
    print(f"skipped (already extracted): {n_skipped}")
    print(f"failed: {len(failures)}")
    for f in failures:
        print(f"  FAILED {f['station']} ({f['slug']}): {f['error']}")

    fail_path = SCRATCH_DIR / "extract_failures.json"
    fail_path.write_text(json.dumps(failures, indent=2) + "\n")


# --------------------------------------------------------------------------
# Step 3: summarize
# --------------------------------------------------------------------------

FEATURE_PATTERNS = {
    "stairs": re.compile(r"STAIR", re.I),
    "underpass": re.compile(r"UNDERPASS", re.I),
    "footbridge": re.compile(r"FOOT\s*BRIDGE", re.I),
    "lift": re.compile(r"\bLIFT\b", re.I),
    "canopy": re.compile(r"CANOPY", re.I),
    "entry": re.compile(r"\bENTR", re.I),
}
PLATFORM_RE = re.compile(r"PLATFORM\s*#?\s*(\d+)", re.I)
SCALE_HINT_RE = re.compile(r"(SCALE|NORTH\s*POINT|\d+\s*:\s*\d+|\bGRID\b|N\s*ARROW)", re.I)


def cmd_summarize(args: argparse.Namespace) -> None:
    if not MANIFEST_PATH.exists():
        print("no manifest.json -- run earlier steps first", file=sys.stderr)
        sys.exit(1)
    entries = {e["slug"]: e for e in json.loads(MANIFEST_PATH.read_text())}

    fail_path = SCRATCH_DIR / "extract_failures.json"
    failures = json.loads(fail_path.read_text()) if fail_path.exists() else []
    failed_slugs = {f["slug"] for f in failures}

    download_failures = [
        {"station": e["station"], "slug": e["slug"], "error": e.get("download_error")}
        for e in entries.values()
        if e.get("download_status") == "failed"
    ]

    vocab: dict[str, int] = {}
    per_station: list[dict] = []
    extents: list[dict] = []
    scale_hints: dict[str, list[str]] = {}
    multi_page: list[dict] = []
    no_geometry: list[dict] = []

    json_files = sorted(SCRATCH_DIR.glob("*.json"))
    parsed_slugs = set()
    for jf in json_files:
        if jf.name in ("summary.json", "extract_failures.json"):
            continue
        data = json.loads(jf.read_text())
        slug = data["station"]["slug"]
        parsed_slugs.add(slug)

        texts = data["texts"]
        paths = data["paths"]

        for t in texts:
            norm = re.sub(r"\s+", " ", t["text"]).strip()
            if norm:
                vocab[norm] = vocab.get(norm, 0) + 1

        platforms = sorted({int(m.group(1)) for t in texts for m in [PLATFORM_RE.search(t["text"])] if m})
        features = {
            feat: any(pat.search(t["text"]) for t in texts) for feat, pat in FEATURE_PATTERNS.items()
        }
        hints = sorted({re.sub(r"\s+", " ", t["text"]).strip() for t in texts if SCALE_HINT_RE.search(t["text"])})
        if hints:
            scale_hints[slug] = hints

        mb = data["source"]["media_box"]
        mb_w = mb[2] - mb[0] if mb else None
        mb_h = mb[3] - mb[1] if mb else None
        bbox = data["bbox"]
        bbox_w = (bbox[2] - bbox[0]) if bbox else None
        bbox_h = (bbox[3] - bbox[1]) if bbox else None

        extents.append(
            {
                "slug": slug,
                "station": data["station"]["name"],
                "media_box": mb,
                "media_box_w": mb_w,
                "media_box_h": mb_h,
                "geometry_bbox": bbox,
                "geometry_bbox_w": bbox_w,
                "geometry_bbox_h": bbox_h,
            }
        )

        page_count = data["source"]["page_count"]
        if page_count != 1:
            multi_page.append({"slug": slug, "station": data["station"]["name"], "page_count": page_count})

        n_paths = len(paths)
        n_texts = len(texts)
        if n_paths == 0 and n_texts == 0:
            no_geometry.append({"slug": slug, "station": data["station"]["name"]})

        per_station.append(
            {
                "slug": slug,
                "station": data["station"]["name"],
                "platforms": platforms,
                "features": features,
                "text_count": n_texts,
                "path_count": n_paths,
                "page_count": page_count,
                "image_count_page1": data["source"].get("image_count_page1", 0),
            }
        )

    vocab_sorted = sorted(vocab.items(), key=lambda kv: (-kv[1], kv[0]))

    widths = [e["media_box_w"] for e in extents if e["media_box_w"]]
    heights = [e["media_box_h"] for e in extents if e["media_box_h"]]
    gbw = [e["geometry_bbox_w"] for e in extents if e["geometry_bbox_w"]]
    gbh = [e["geometry_bbox_h"] for e in extents if e["geometry_bbox_h"]]

    def stats(vals):
        if not vals:
            return None
        return {"min": min(vals), "max": max(vals), "mean": round(sum(vals) / len(vals), 2)}

    summary = {
        "counts": {
            "manifest_total": len(entries),
            "downloaded_ok": sum(1 for e in entries.values() if e.get("download_status") in ("downloaded", "cached")),
            "download_failed": len(download_failures),
            "parsed_ok": len(parsed_slugs),
            "parse_failed": len(failures),
        },
        "download_failures": download_failures,
        "parse_failures": failures,
        "label_vocabulary": [{"text": t, "count": c} for t, c in vocab_sorted],
        "distinct_label_count": len(vocab_sorted),
        "per_station": per_station,
        "coordinate_space": {
            "media_box_width_stats": stats(widths),
            "media_box_height_stats": stats(heights),
            "geometry_bbox_width_stats": stats(gbw),
            "geometry_bbox_height_stats": stats(gbh),
            "extents_by_station": extents,
            "scale_or_grid_hints_by_station": scale_hints,
        },
        "anomalies": {
            "multi_page": multi_page,
            "no_geometry_extracted": no_geometry,
        },
    }
    SUMMARY_PATH.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"wrote {SUMMARY_PATH}")

    _write_report(summary)
    print(f"wrote {REPORT_PATH}")


def _write_report(summary: dict) -> None:
    c = summary["counts"]
    lines = []
    lines.append("# Station CAD Drawings -- extraction report\n")
    lines.append(
        f"- Manifest entries (station PDF resources found via CKAN): **{c['manifest_total']}**\n"
        f"- Downloaded OK: **{c['downloaded_ok']}**\n"
        f"- Download failures: **{c['download_failed']}**\n"
        f"- Parsed OK: **{c['parsed_ok']}**\n"
        f"- Parse failures: **{c['parse_failed']}**\n"
    )

    if summary["download_failures"]:
        lines.append("## Download failures\n")
        for f in summary["download_failures"]:
            lines.append(f"- {f['station']} ({f['slug']}): {f['error']}")
        lines.append("")

    if summary["parse_failures"]:
        lines.append("## Parse failures\n")
        for f in summary["parse_failures"]:
            lines.append(f"- {f['station']} ({f['slug']}): {f['error']}")
        lines.append("")

    lines.append("## Label vocabulary\n")
    lines.append(f"{summary['distinct_label_count']} distinct label strings across the corpus. Most common first:\n")
    lines.append("| count | label |")
    lines.append("|---:|---|")
    for entry in summary["label_vocabulary"][:200]:
        text = entry["text"].replace("|", "\\|")
        lines.append(f"| {entry['count']} | `{text}` |")
    if len(summary["label_vocabulary"]) > 200:
        lines.append(f"\n_...and {len(summary['label_vocabulary']) - 200} more, in summary.json._")
    lines.append("")

    cs = summary["coordinate_space"]
    lines.append("## Coordinate space\n")
    lines.append(f"- MediaBox width across corpus: {cs['media_box_width_stats']}")
    lines.append(f"- MediaBox height across corpus: {cs['media_box_height_stats']}")
    lines.append(f"- Drawn-geometry bbox width across corpus: {cs['geometry_bbox_width_stats']}")
    lines.append(f"- Drawn-geometry bbox height across corpus: {cs['geometry_bbox_height_stats']}")
    lines.append("")
    if cs["scale_or_grid_hints_by_station"]:
        lines.append("### Scale bar / north arrow / grid / dimension text found\n")
        for slug, hints in sorted(cs["scale_or_grid_hints_by_station"].items()):
            lines.append(f"- **{slug}**: " + "; ".join(f'"{h}"' for h in hints))
    else:
        lines.append("No station carried text matching SCALE / north point / ratio (`N:N`) / GRID patterns.")
    lines.append("")

    an = summary["anomalies"]
    lines.append("## Anomalies\n")
    if an["multi_page"]:
        lines.append("### Multi-page drawings\n")
        for m in an["multi_page"]:
            lines.append(f"- {m['station']} ({m['slug']}): {m['page_count']} pages")
    else:
        lines.append("No multi-page PDFs.")
    lines.append("")
    if an["no_geometry_extracted"]:
        lines.append("### No text or path geometry extracted\n")
        for m in an["no_geometry_extracted"]:
            lines.append(f"- {m['station']} ({m['slug']})")
    lines.append("")

    lines.append("## Per-station feature flags\n")
    lines.append("| station | platforms | stairs | underpass | footbridge | lift | canopy | entry | texts | paths |")
    lines.append("|---|---|---|---|---|---|---|---|---:|---:|")
    for s in summary["per_station"]:
        f = s["features"]
        plat = ",".join(str(p) for p in s["platforms"]) or "-"
        lines.append(
            f"| {s['station']} | {plat} | "
            f"{'Y' if f['stairs'] else ''} | {'Y' if f['underpass'] else ''} | "
            f"{'Y' if f['footbridge'] else ''} | {'Y' if f['lift'] else ''} | "
            f"{'Y' if f['canopy'] else ''} | {'Y' if f['entry'] else ''} | "
            f"{s['text_count']} | {s['path_count']} |"
        )
    REPORT_PATH.write_text("\n".join(lines) + "\n")


# --------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_enum = sub.add_parser("enumerate", help="query CKAN, write manifest.json")
    p_enum.add_argument("--refresh", action="store_true", help="re-query even if manifest.json exists")
    p_enum.set_defaults(func=cmd_enumerate)

    p_dl = sub.add_parser("download", help="download every PDF in the manifest")
    p_dl.add_argument("--concurrency", type=int, default=6)
    p_dl.add_argument("--retries", type=int, default=4)
    p_dl.set_defaults(func=cmd_download)

    p_ex = sub.add_parser("extract", help="parse every cached PDF to JSON")
    p_ex.add_argument("--force", action="store_true", help="re-parse even if the JSON already exists")
    p_ex.set_defaults(func=cmd_extract)

    p_sum = sub.add_parser("summarize", help="write summary.json + REPORT.md")
    p_sum.set_defaults(func=cmd_summarize)

    p_all = sub.add_parser("all", help="run enumerate, download, extract, summarize in order")
    p_all.add_argument("--refresh", action="store_true")
    p_all.add_argument("--concurrency", type=int, default=6)
    p_all.add_argument("--retries", type=int, default=4)
    p_all.add_argument("--force", action="store_true")

    def run_all(args: argparse.Namespace) -> None:
        cmd_enumerate(args)
        cmd_download(args)
        cmd_extract(args)
        cmd_summarize(args)

    p_all.set_defaults(func=run_all)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
