#!/usr/bin/env python3
"""Build, review, write, and verify the balanced Pilot 2 target set.

This script intentionally leaves fillers/vigilance and server data untouched.
Stable target slot filenames, levels, roles, and level positions are preserved.
"""

from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import io
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
DATASET = ROOT / "dataset"
TARGET_DIR = DATASET / "target"
FILLER_DIR = DATASET / "filler"
BACKUP_ROOT = ROOT / "dataset_backups"
SPREADSHEET_ID = "131MariuXQgXsXO6CjC0tjVCkrCyWDEGXCjHXCG-s8Ow"
SOURCE_TARGET_TAB = "All Targets"
SOURCE_PILOT_TAB = "pilot2_dataset_06_18"
OUTPUT_TAB = "pilot2_balanced_targets_v2"
SEED = "pilot2-balanced-targets-v1"
DATE_TAG = "2026_07_16"

CANONICAL_TYPES = [
    "Area",
    "Bar",
    "Cont.-ColorPatn",
    "Glyph",
    "Grid",
    "Grid and Matrix",
    "Line",
    "Node-link",
    "Point",
    "Text",
]

PILOT_HEADERS = [
    "mark",
    "level",
    "image",
    "role",
    "level_position",
    "dataset_filename",
    "source_type",
    "source_sheet",
    "source_row",
    "source_index",
    "source_image_id",
    "source_image_name",
    "source_url",
    "final_vis_types",
    "dataset",
    "data_source",
    "random_seed",
]

LOCAL_SELECTION = DATASET / "pilot2_dataset_selection_2026_06_17.csv"
TARGET_MANIFEST = TARGET_DIR / "manifest.json"
TARGET_LEVEL_MAP = DATASET / "pilot_targets_level_map.csv"
STATE_PATH = DATASET / "pilot2_balanced_targets_v2_state.json"
SHEET_VALUES_PATH = DATASET / "pilot2_balanced_targets_v2_sheet_values.json"
FINAL_SELECTION_PATH = DATASET / "pilot2_balanced_targets_v2_selection.csv"
AUDIT_PATH = DATASET / f"pilot2_balanced_target_before_after_{DATE_TAG}.csv"
REVIEW_LOG_PATH = DATASET / f"pilot2_balanced_target_visual_review_log_{DATE_TAG}.csv"
SUMMARY_PATH = DATASET / "pilot2_balanced_targets_v2_summary.json"
VALIDATION_PATH = DATASET / "pilot2_balanced_targets_v2_validation.json"
CONTACT_PATH = DATASET / f"pilot2_balanced_targets_contact_sheet_{DATE_TAG}.png"
CONTACT_DIR = DATASET / f"pilot2_balanced_targets_contact_sheets_{DATE_TAG}"


def run_json(command: list[str]) -> dict[str, Any]:
    proc = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    if proc.returncode:
        raise RuntimeError(
            f"Command failed ({proc.returncode}): {' '.join(command[:4])}\n{proc.stderr.strip()}"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON from command: {' '.join(command[:4])}") from exc


def gog_get(a1_range: str) -> list[list[str]]:
    payload = run_json(
        ["gog", "sheets", "get", SPREADSHEET_ID, a1_range, "--json", "--no-input"]
    )
    return [[str(cell) for cell in row] for row in payload.get("values", [])]


def pad(row: list[str], width: int) -> list[str]:
    return (list(row) + [""] * width)[:width]


def image_prefix(name: str) -> str:
    base = os.path.basename(str(name or "").strip())
    parts = base.split(".")
    if len(parts) >= 3:
        return ".".join(parts[:2])
    return os.path.splitext(base)[0]


def primary_type(vis_types: str) -> str:
    return str(vis_types or "").split(";", 1)[0].strip()


def valid_url(url: str) -> bool:
    return url.startswith("https://") or url.startswith("http://")


def pixel_digest(image: Image.Image) -> str:
    rgb = image.convert("RGB")
    h = hashlib.sha256()
    h.update(f"{rgb.width}x{rgb.height}|".encode())
    h.update(rgb.tobytes())
    return h.hexdigest()


def load_image_bytes(data: bytes) -> tuple[Image.Image, int, int, float, str]:
    with Image.open(io.BytesIO(data)) as source:
        source.load()
        image = source.copy()
    width, height = image.size
    if width <= 0 or height <= 0:
        raise ValueError("zero-sized image")
    ratio = max(width / height, height / width)
    return image, width, height, ratio, pixel_digest(image)


def download_candidate(candidate: dict[str, Any]) -> tuple[Image.Image, int, int, float, str]:
    request = urllib.request.Request(
        candidate["source_url"], headers={"User-Agent": "pilot2-balanced-target-builder/1.0"}
    )
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read(30 * 1024 * 1024 + 1)
            if len(data) > 30 * 1024 * 1024:
                raise ValueError("image exceeds 30 MiB")
            return load_image_bytes(data)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(str(last_error))


def local_image_digests(directory: Path, *, exclude_manifest: bool = True) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(directory.iterdir()):
        if not path.is_file() or (exclude_manifest and path.name == "manifest.json"):
            continue
        try:
            with Image.open(path) as image:
                image.load()
                result[path.name] = pixel_digest(image)
        except OSError as exc:
            raise RuntimeError(f"Cannot decode local image {path}: {exc}") from exc
    return result


def candidate_from_row(headers: list[str], row: list[str], sheet_row: int) -> dict[str, Any] | None:
    values = dict(zip(headers, pad(row, len(headers))))
    name = values.get("ImageName", "").strip()
    url = values.get("ImageLink", "").strip()
    vis_types = values.get("VisTypes", "").strip()
    primary = primary_type(vis_types)
    lowered = vis_types.lower()
    if not name or not valid_url(url):
        return None
    if lowered == "nv" or "<nv>" in lowered:
        return None
    if primary not in CANONICAL_TYPES:
        return None
    return {
        "source_type": "target",
        "source_sheet": SOURCE_TARGET_TAB,
        "source_row": str(sheet_row),
        "source_index": values.get("Index", "").strip(),
        "source_image_id": "",
        "source_image_name": name,
        "source_url": url,
        "final_vis_types": vis_types,
        "primary_type": primary,
        "dataset": values.get("Dataset", "").strip(),
        "data_source": values.get("DataSource", "").strip(),
        "prefix": image_prefix(name),
    }


def read_live_sources() -> tuple[list[list[str]], list[dict[str, Any]]]:
    pilot = gog_get(f"'{SOURCE_PILOT_TAB}'!A1:Q220")
    if not pilot or pad(pilot[0], 17) != PILOT_HEADERS:
        raise RuntimeError("Live pilot header does not match the expected A:Q schema")
    pilot = [pad(row, 17) for row in pilot]
    if len(pilot) != 197:
        raise RuntimeError(f"Expected 196 live data rows, found {len(pilot) - 1}")
    role_counts = collections.Counter(row[3] for row in pilot[1:])
    expected = {"target": 32, "vigilance_source": 12, "filler_single": 152}
    if role_counts != expected:
        raise RuntimeError(f"Unexpected live role counts: {dict(role_counts)}")

    raw_targets = gog_get(f"'{SOURCE_TARGET_TAB}'!A1:L1778")
    if not raw_targets:
        raise RuntimeError("All Targets returned no rows")
    headers = pad(raw_targets[0], 12)
    needed = {"Index", "ImageName", "ImageLink", "Dataset", "DataSource", "VisTypes"}
    if not needed.issubset(headers):
        raise RuntimeError(f"All Targets is missing headers: {sorted(needed - set(headers))}")
    candidates: list[dict[str, Any]] = []
    for sheet_row, row in enumerate(raw_targets[1:], start=2):
        candidate = candidate_from_row(headers, row, sheet_row)
        if candidate:
            candidates.append(candidate)
    return pilot, candidates


def prepare_blocked_non_targets(pilot: list[list[str]]) -> dict[str, list[str]]:
    rows = [row for row in pilot[1:] if row[3] != "target"]
    return {
        "names": sorted({row[11].strip() for row in rows if row[11].strip()}),
        "urls": sorted({row[12].strip() for row in rows if row[12].strip()}),
        "ids": sorted({row[10].strip() for row in rows if row[10].strip()}),
        "prefixes": sorted({image_prefix(row[11]) for row in rows if row[11].strip()}),
    }


def select_initial(
    candidates: list[dict[str, Any]], blocked: dict[str, list[str]], filler_digests: set[str]
) -> tuple[list[dict[str, Any]], dict[str, int], list[dict[str, str]]]:
    rng = random.Random(SEED)
    quota_order = list(CANONICAL_TYPES)
    rng.shuffle(quota_order)
    quotas = {category: 3 for category in CANONICAL_TYPES}
    for category in quota_order[:2]:
        quotas[category] = 4

    by_type: dict[str, list[dict[str, Any]]] = {category: [] for category in CANONICAL_TYPES}
    seen_candidate_rows: set[str] = set()
    for candidate in candidates:
        if candidate["source_row"] in seen_candidate_rows:
            continue
        seen_candidate_rows.add(candidate["source_row"])
        by_type[candidate["primary_type"]].append(candidate)

    blocked_names = set(blocked["names"])
    blocked_urls = set(blocked["urls"])
    blocked_prefixes = set(blocked["prefixes"])
    used_names: set[str] = set()
    used_urls: set[str] = set()
    used_prefixes: set[str] = set()
    used_rows: set[str] = set()
    used_digests: set[str] = set()
    selected: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []

    with tempfile.TemporaryDirectory(prefix="pilot2-balanced-select-") as tmp:
        temp_dir = Path(tmp)
        for category in CANONICAL_TYPES:
            pool = sorted(by_type[category], key=lambda item: int(item["source_row"]))
            rng.shuffle(pool)
            accepted = 0
            for candidate in pool:
                if accepted >= quotas[category]:
                    break
                reason = ""
                if candidate["source_row"] in used_rows:
                    reason = "duplicate source row"
                elif candidate["source_image_name"] in blocked_names | used_names:
                    reason = "duplicate source image name"
                elif candidate["source_url"] in blocked_urls | used_urls:
                    reason = "duplicate source URL"
                elif candidate["prefix"] in blocked_prefixes | used_prefixes:
                    reason = "prefix collision"
                if reason:
                    rejected.append({"source_row": candidate["source_row"], "reason": reason})
                    continue
                try:
                    image, width, height, ratio, digest = download_candidate(candidate)
                except RuntimeError as exc:
                    rejected.append({"source_row": candidate["source_row"], "reason": f"invalid/download: {exc}"})
                    continue
                if ratio > 3.0:
                    rejected.append({"source_row": candidate["source_row"], "reason": f"aspect ratio {ratio:.6f}"})
                    continue
                if digest in filler_digests | used_digests:
                    rejected.append({"source_row": candidate["source_row"], "reason": "duplicate image pixels"})
                    continue
                staged = temp_dir / f"candidate_{candidate['source_row']}.png"
                image.save(staged, format="PNG")
                chosen = dict(candidate)
                chosen.update(
                    {
                        "width": width,
                        "height": height,
                        "aspect_ratio": round(ratio, 8),
                        "pixel_digest": digest,
                        "staged_path": str(staged),
                        "selection_order": len(selected) + 1,
                    }
                )
                selected.append(chosen)
                used_rows.add(chosen["source_row"])
                used_names.add(chosen["source_image_name"])
                used_urls.add(chosen["source_url"])
                used_prefixes.add(chosen["prefix"])
                used_digests.add(digest)
                accepted += 1
            if accepted != quotas[category]:
                raise RuntimeError(
                    f"Could only select {accepted}/{quotas[category]} valid images for {category}"
                )

        if len(selected) != 32:
            raise RuntimeError(f"Expected 32 selected targets, found {len(selected)}")
        persistent = DATASET / ".pilot2_balanced_staging"
        if persistent.exists():
            shutil.rmtree(persistent)
        persistent.mkdir(parents=True)
        for item in selected:
            source = Path(item["staged_path"])
            dest = persistent / source.name
            shutil.copy2(source, dest)
            item["staged_path"] = str(dest)
    return selected, quotas, rejected


def make_backup(pilot: list[list[str]]) -> Path:
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = BACKUP_ROOT / f"dataset_before_balanced_targets_{stamp}"
    backup.mkdir()
    shutil.copytree(TARGET_DIR, backup / "target")
    for path in [LOCAL_SELECTION, TARGET_MANIFEST, TARGET_LEVEL_MAP]:
        if path.exists():
            shutil.copy2(path, backup / path.name)
    (backup / "pilot2_dataset_06_18_live_values.json").write_text(
        json.dumps({"values": pilot}, ensure_ascii=False, indent=2) + "\n"
    )
    return backup


def slot_record(row: list[str], sheet_row: int) -> dict[str, Any]:
    return {
        "sheet_row": sheet_row,
        "level": row[1],
        "role": row[3],
        "level_position": row[4],
        "dataset_filename": row[5],
        "source_type": row[6],
        "source_sheet": row[7],
        "source_row": row[8],
        "source_index": row[9],
        "source_image_id": row[10],
        "source_image_name": row[11],
        "source_url": row[12],
        "final_vis_types": row[13],
        "primary_type": primary_type(row[13]),
        "dataset": row[14],
        "data_source": row[15],
        "random_seed": row[16],
        "prefix": image_prefix(row[11]),
    }


def apply_candidate_to_row(row: list[str], candidate: dict[str, Any], seed: str) -> None:
    row[6] = "target"
    row[7] = SOURCE_TARGET_TAB
    row[8] = str(candidate["source_row"])
    row[9] = str(candidate["source_index"])
    row[10] = ""
    row[11] = candidate["source_image_name"]
    row[12] = candidate["source_url"]
    row[13] = candidate["final_vis_types"]
    row[14] = candidate["dataset"]
    row[15] = candidate["data_source"]
    row[16] = seed


def candidate_to_current(candidate: dict[str, Any], row: list[str], sheet_row: int, seed: str) -> dict[str, Any]:
    current = dict(candidate)
    current.pop("staged_path", None)
    current.update(
        {
            "sheet_row": sheet_row,
            "level": row[1],
            "role": row[3],
            "level_position": row[4],
            "dataset_filename": row[5],
            "random_seed": seed,
        }
    )
    return current


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def update_local_selection(state: dict[str, Any]) -> None:
    with LOCAL_SELECTION.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        fields = list(reader.fieldnames or [])
        rows = list(reader)
    current_by_slot = {item["dataset_filename"]: item for item in state["current_targets"]}
    seen: set[str] = set()
    for row in rows:
        if row.get("role") != "target":
            continue
        slot = row.get("dataset_filename", "")
        item = current_by_slot.get(slot)
        if not item:
            raise RuntimeError(f"Local selection has unknown target slot {slot}")
        seen.add(slot)
        for field in [
            "level",
            "role",
            "level_position",
            "source_type",
            "source_sheet",
            "source_row",
            "source_index",
            "source_image_name",
            "source_image_id",
            "source_url",
            "dataset_filename",
            "final_vis_types",
            "dataset",
            "data_source",
        ]:
            row[field] = str(item.get(field, ""))
    if seen != set(current_by_slot):
        raise RuntimeError("Local selection target slots do not match live Sheet slots")
    write_csv(LOCAL_SELECTION, rows, fields)


def draw_contact_sheet(items: list[dict[str, Any]], path: Path, title: str, columns: int = 4) -> None:
    tile_w, image_h, label_h, gap = 390, 250, 72, 12
    tile_h = image_h + label_h
    rows = (len(items) + columns - 1) // columns
    header_h = 56
    canvas = Image.new("RGB", (columns * tile_w + (columns + 1) * gap, header_h + rows * tile_h + (rows + 1) * gap), "white")
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 17)
        small = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 14)
        title_font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 25)
    except OSError:
        font = small = title_font = ImageFont.load_default()
    draw.text((gap, 14), title, fill="black", font=title_font)
    for index, item in enumerate(items):
        row, col = divmod(index, columns)
        x = gap + col * (tile_w + gap)
        y = header_h + gap + row * (tile_h + gap)
        draw.rectangle((x, y, x + tile_w, y + tile_h), outline=(190, 190, 190), width=2)
        image_path = TARGET_DIR / item["dataset_filename"]
        with Image.open(image_path) as source:
            source.load()
            thumb = source.convert("RGB")
        thumb.thumbnail((tile_w - 18, image_h - 16), Image.Resampling.LANCZOS)
        tx = x + (tile_w - thumb.width) // 2
        ty = y + (image_h - thumb.height) // 2
        canvas.paste(thumb, (tx, ty))
        label_y = y + image_h + 4
        draw.text((x + 7, label_y), f"{item['primary_type']} | L{item['level']} P{item['level_position']}", fill="black", font=font)
        draw.text((x + 7, label_y + 23), item["dataset_filename"], fill=(45, 45, 45), font=small)
        source_label = f"row {item['source_row']} | {item['source_image_name']}"
        if len(source_label) > 49:
            source_label = source_label[:46] + "..."
        draw.text((x + 7, label_y + 43), source_label, fill=(70, 70, 70), font=small)
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path, format="PNG", optimize=True)


def generate_contact_sheets(state: dict[str, Any]) -> None:
    items = sorted(
        state["current_targets"],
        key=lambda item: (CANONICAL_TYPES.index(item["primary_type"]), int(item["level"]), int(item["level_position"])),
    )
    draw_contact_sheet(items, CONTACT_PATH, "Pilot 2 balanced targets — grouped by primary VIS type")
    CONTACT_DIR.mkdir(parents=True, exist_ok=True)
    expected: set[str] = set()
    for category in CANONICAL_TYPES:
        category_items = [item for item in items if item["primary_type"] == category]
        safe = category.lower().replace(" ", "_").replace(".", "").replace("-", "_")
        path = CONTACT_DIR / f"{CANONICAL_TYPES.index(category)+1:02d}_{safe}.png"
        expected.add(path.name)
        draw_contact_sheet(category_items, path, f"{category} — {len(category_items)} targets", columns=2)
    for path in CONTACT_DIR.glob("*.png"):
        if path.name not in expected:
            path.unlink()


def write_artifacts(state: dict[str, Any]) -> None:
    state["updated_at"] = datetime.now().isoformat(timespec="seconds")
    state["current_targets"] = sorted(state["current_targets"], key=lambda item: item["sheet_row"])
    update_local_selection(state)

    SHEET_VALUES_PATH.write_text(
        json.dumps({"values": state["current_values"]}, ensure_ascii=False, indent=2) + "\n"
    )
    selection_fields = PILOT_HEADERS[1:]
    selection_rows = []
    for row in state["current_values"][1:]:
        selection_rows.append(dict(zip(PILOT_HEADERS, row)))
    write_csv(FINAL_SELECTION_PATH, selection_rows, selection_fields)

    original = {item["dataset_filename"]: item for item in state["original_targets"]}
    current = {item["dataset_filename"]: item for item in state["current_targets"]}
    audit_rows: list[dict[str, Any]] = []
    for slot in sorted(current, key=lambda s: current[s]["sheet_row"]):
        before, after = original[slot], current[slot]
        audit_rows.append(
            {
                "sheet_row": after["sheet_row"],
                "level": after["level"],
                "level_position": after["level_position"],
                "dataset_filename": slot,
                "before_source_row": before["source_row"],
                "before_source_index": before["source_index"],
                "before_source_image_name": before["source_image_name"],
                "before_source_url": before["source_url"],
                "before_primary_type": before["primary_type"],
                "after_source_row": after["source_row"],
                "after_source_index": after["source_index"],
                "after_source_image_name": after["source_image_name"],
                "after_source_url": after["source_url"],
                "after_final_vis_types": after["final_vis_types"],
                "after_primary_type": after["primary_type"],
                "after_prefix": after["prefix"],
                "width": after["width"],
                "height": after["height"],
                "aspect_ratio": after["aspect_ratio"],
                "selection_seed": after["random_seed"],
            }
        )
    audit_fields = list(audit_rows[0])
    write_csv(AUDIT_PATH, audit_rows, audit_fields)

    review_fields = [
        "round",
        "replace_slot",
        "keep_slot",
        "reason",
        "replacement_seed",
        "before_source_row",
        "before_source_image_name",
        "after_source_row",
        "after_source_image_name",
        "primary_type",
    ]
    write_csv(REVIEW_LOG_PATH, state.get("review_log", []), review_fields)

    generate_contact_sheets(state)
    counts = collections.Counter(item["primary_type"] for item in state["current_targets"])
    summary = {
        "seed": SEED,
        "spreadsheet_id": SPREADSHEET_ID,
        "source_pilot_tab": SOURCE_PILOT_TAB,
        "output_tab": OUTPUT_TAB,
        "backup_dir": state["backup_dir"],
        "target_count": len(state["current_targets"]),
        "primary_type_counts": {category: counts[category] for category in CANONICAL_TYPES},
        "quota": state["quotas"],
        "visual_review_rounds": state.get("visual_review_rounds", 0),
        "visual_review_replacements": len(state.get("review_log", [])),
        "final_visual_review_status": state.get("final_visual_review_status", "pending"),
        "final_visual_review_round": state.get("final_visual_review_round", ""),
        "server_synced": False,
        "contact_sheet": str(CONTACT_PATH),
        "audit_csv": str(AUDIT_PATH),
        "sheet_values_json": str(SHEET_VALUES_PATH),
    }
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")


def prepare() -> None:
    if STATE_PATH.exists():
        raise RuntimeError(
            f"State already exists at {STATE_PATH}; move it aside before starting a new selection"
        )
    pilot, candidates = read_live_sources()
    blocked = prepare_blocked_non_targets(pilot)
    filler_digest_map = local_image_digests(FILLER_DIR)
    selected, quotas, rejected = select_initial(candidates, blocked, set(filler_digest_map.values()))

    target_indices = [index for index, row in enumerate(pilot) if index and row[3] == "target"]
    rng = random.Random(SEED)
    quota_order = list(CANONICAL_TYPES)
    rng.shuffle(quota_order)
    for category in CANONICAL_TYPES:
        dummy = sorted([item for item in candidates if item["primary_type"] == category], key=lambda item: int(item["source_row"]))
        rng.shuffle(dummy)
    rng.shuffle(selected)

    backup = make_backup(pilot)
    original_targets = [slot_record(pilot[index], index + 1) for index in target_indices]
    current_targets: list[dict[str, Any]] = []
    for row_index, candidate in zip(target_indices, selected, strict=True):
        row = pilot[row_index]
        stable_slot = row[5]
        shutil.copy2(candidate["staged_path"], TARGET_DIR / stable_slot)
        apply_candidate_to_row(row, candidate, SEED)
        current_targets.append(candidate_to_current(candidate, row, row_index + 1, SEED))

    shutil.rmtree(DATASET / ".pilot2_balanced_staging", ignore_errors=True)
    state = {
        "version": 1,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "spreadsheet_id": SPREADSHEET_ID,
        "source_target_tab": SOURCE_TARGET_TAB,
        "source_pilot_tab": SOURCE_PILOT_TAB,
        "output_tab": OUTPUT_TAB,
        "seed": SEED,
        "backup_dir": str(backup),
        "baseline_values": json.loads((backup / "pilot2_dataset_06_18_live_values.json").read_text())["values"],
        "current_values": pilot,
        "original_targets": original_targets,
        "current_targets": current_targets,
        "quotas": quotas,
        "blocked_non_targets": blocked,
        "filler_pixel_digests": sorted(set(filler_digest_map.values())),
        "candidate_pool": candidates,
        "initial_rejections": rejected,
        "seen_source_rows": sorted(item["source_row"] for item in selected),
        "review_log": [],
        "visual_review_rounds": 0,
    }
    write_artifacts(state)
    validate_local(state)
    print(json.dumps(json.loads(SUMMARY_PATH.read_text()), ensure_ascii=False, indent=2))


def load_state() -> dict[str, Any]:
    if not STATE_PATH.exists():
        raise RuntimeError(f"Missing state file: {STATE_PATH}")
    return json.loads(STATE_PATH.read_text())


def replace_one(round_number: int, replace_slot: str, keep_slot: str, reason: str) -> None:
    if round_number < 1 or round_number > 5:
        raise RuntimeError("Visual review round must be between 1 and 5")
    state = load_state()
    current_by_slot = {item["dataset_filename"]: item for item in state["current_targets"]}
    if replace_slot not in current_by_slot:
        raise RuntimeError(f"Unknown replace slot: {replace_slot}")
    if keep_slot and keep_slot not in current_by_slot:
        raise RuntimeError(f"Unknown keep slot: {keep_slot}")
    before = current_by_slot[replace_slot]
    category = before["primary_type"]
    replacement_seed = f"{SEED}|visual-review|{round_number}|{replace_slot}"
    rng = random.Random(replacement_seed)
    pool = [dict(item) for item in state["candidate_pool"] if item["primary_type"] == category]
    pool.sort(key=lambda item: int(item["source_row"]))
    rng.shuffle(pool)

    other = [item for item in state["current_targets"] if item["dataset_filename"] != replace_slot]
    blocked_names = set(state["blocked_non_targets"]["names"]) | {item["source_image_name"] for item in other}
    blocked_urls = set(state["blocked_non_targets"]["urls"]) | {item["source_url"] for item in other}
    blocked_prefixes = set(state["blocked_non_targets"]["prefixes"]) | {item["prefix"] for item in other}
    blocked_digests = set(state["filler_pixel_digests"]) | {item["pixel_digest"] for item in other}
    seen_rows = set(state.get("seen_source_rows", []))

    chosen: dict[str, Any] | None = None
    chosen_image: Image.Image | None = None
    for candidate in pool:
        if candidate["source_row"] in seen_rows:
            continue
        if candidate["source_image_name"] in blocked_names:
            continue
        if candidate["source_url"] in blocked_urls:
            continue
        if candidate["prefix"] in blocked_prefixes:
            continue
        try:
            image, width, height, ratio, digest = download_candidate(candidate)
        except RuntimeError:
            continue
        if ratio > 3.0 or digest in blocked_digests:
            continue
        chosen = dict(candidate)
        chosen.update(
            {
                "width": width,
                "height": height,
                "aspect_ratio": round(ratio, 8),
                "pixel_digest": digest,
                "selection_order": before.get("selection_order", ""),
            }
        )
        chosen_image = image
        break
    if not chosen or chosen_image is None:
        raise RuntimeError(f"No valid same-type replacement found for {replace_slot}")

    backup_round = Path(state["backup_dir"]) / f"visual_review_round_{round_number}_before"
    backup_round.mkdir(parents=True, exist_ok=True)
    target_path = TARGET_DIR / replace_slot
    if not (backup_round / replace_slot).exists():
        shutil.copy2(target_path, backup_round / replace_slot)
    chosen_image.save(target_path, format="PNG")

    row_index = int(before["sheet_row"]) - 1
    row = state["current_values"][row_index]
    apply_candidate_to_row(row, chosen, replacement_seed)
    after = candidate_to_current(chosen, row, int(before["sheet_row"]), replacement_seed)
    state["current_targets"] = [after if item["dataset_filename"] == replace_slot else item for item in state["current_targets"]]
    state.setdefault("seen_source_rows", []).append(chosen["source_row"])
    state["seen_source_rows"] = sorted(set(state["seen_source_rows"]), key=int)
    state["visual_review_rounds"] = max(int(state.get("visual_review_rounds", 0)), round_number)
    state.setdefault("review_log", []).append(
        {
            "round": round_number,
            "replace_slot": replace_slot,
            "keep_slot": keep_slot,
            "reason": reason,
            "replacement_seed": replacement_seed,
            "before_source_row": before["source_row"],
            "before_source_image_name": before["source_image_name"],
            "after_source_row": after["source_row"],
            "after_source_image_name": after["source_image_name"],
            "primary_type": category,
        }
    )
    write_artifacts(state)
    validate_local(state)
    print(json.dumps(state["review_log"][-1], ensure_ascii=False, indent=2))


def mark_review_clean(round_number: int, note: str) -> None:
    if round_number < 1 or round_number > 5:
        raise RuntimeError("Visual review round must be between 1 and 5")
    state = load_state()
    state["visual_review_rounds"] = max(int(state.get("visual_review_rounds", 0)), round_number)
    state["final_visual_review_status"] = "clean"
    state["final_visual_review_round"] = round_number
    state["final_visual_review_note"] = note
    write_artifacts(state)
    validate_local(state)
    print(json.dumps({"round": round_number, "status": "clean", "note": note}, ensure_ascii=False, indent=2))


def normalize_values(values: list[list[str]]) -> list[list[str]]:
    return [pad([str(cell) for cell in row], 17) for row in values]


def write_sheet(tab: str) -> None:
    state = load_state()
    baseline_live = normalize_values(gog_get(f"'{tab}'!A1:Q197"))
    baseline_expected = normalize_values(state["baseline_values"])
    if baseline_live != baseline_expected:
        raise RuntimeError(
            f"Refusing to write: {tab}!A1:Q197 is not an exact duplicate of {SOURCE_PILOT_TAB}"
        )
    values_json = json.dumps(state["current_values"], ensure_ascii=False, separators=(",", ":"))
    run_json(
        [
            "gog",
            "sheets",
            "update",
            SPREADSHEET_ID,
            f"'{tab}'!A1:Q197",
            "--values-json",
            values_json,
            "--input",
            "RAW",
            "--json",
            "--no-input",
        ]
    )
    readback = normalize_values(gog_get(f"'{tab}'!A1:Q197"))
    expected = normalize_values(state["current_values"])
    if readback != expected:
        for index, (actual, wanted) in enumerate(zip(readback, expected), start=1):
            if actual != wanted:
                raise RuntimeError(f"Sheet readback mismatch at row {index}: {actual!r} != {wanted!r}")
        raise RuntimeError("Sheet readback mismatch (row count differs)")
    verify_sheet_rows(state, readback)
    state["sheet_written_at"] = datetime.now().isoformat(timespec="seconds")
    state["sheet_readback_verified"] = True
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"tab": tab, "range": "A1:Q197", "readback": "exact", "data_rows": 196}, indent=2))


def sync_sheet_targets(tab: str) -> None:
    state = load_state()
    live = normalize_values(gog_get(f"'{tab}'!A1:Q197"))
    baseline = normalize_values(state["baseline_values"])
    for index, row in enumerate(live):
        if index and baseline[index][3] != "target" and row != baseline[index]:
            raise RuntimeError(f"Non-target row {index + 1} changed in {tab}; refusing to sync targets")
    values_json = json.dumps(state["current_values"], ensure_ascii=False, separators=(",", ":"))
    run_json(
        [
            "gog",
            "sheets",
            "update",
            SPREADSHEET_ID,
            f"'{tab}'!A1:Q197",
            "--values-json",
            values_json,
            "--input",
            "RAW",
            "--json",
            "--no-input",
        ]
    )
    readback = normalize_values(gog_get(f"'{tab}'!A1:Q197"))
    if readback != normalize_values(state["current_values"]):
        raise RuntimeError("Post-review Sheet sync readback mismatch")
    verify_sheet_rows(state, readback)
    state["sheet_written_at"] = datetime.now().isoformat(timespec="seconds")
    state["sheet_readback_verified"] = True
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"tab": tab, "range": "A1:Q197", "readback": "exact", "review_sync": True}, indent=2))


def verify_sheet_rows(state: dict[str, Any], rows: list[list[str]]) -> None:
    if len(rows) != 197:
        raise RuntimeError(f"Expected 197 rows including header, found {len(rows)}")
    counts = collections.Counter(row[3] for row in rows[1:])
    expected_counts = {"target": 32, "vigilance_source": 12, "filler_single": 152}
    if counts != expected_counts:
        raise RuntimeError(f"Unexpected Sheet role counts: {dict(counts)}")
    baseline = normalize_values(state["baseline_values"])
    for index in range(1, len(rows)):
        if baseline[index][3] != "target" and rows[index] != baseline[index]:
            raise RuntimeError(f"Filler/vigilance row {index + 1} differs from source tab")


def validate_local(state: dict[str, Any]) -> dict[str, Any]:
    current = state["current_targets"]
    if len(current) != 32:
        raise RuntimeError(f"Expected 32 current targets, found {len(current)}")
    counts = collections.Counter(item["primary_type"] for item in current)
    if set(counts) != set(CANONICAL_TYPES) or min(counts.values()) != 3 or max(counts.values()) != 4:
        raise RuntimeError(f"Unbalanced primary VIS types: {dict(counts)}")
    manifest = json.loads(TARGET_MANIFEST.read_text())
    manifest_files = list(manifest.get("files", []))
    if len(manifest_files) != 32 or set(manifest_files) != {item["dataset_filename"] for item in current}:
        raise RuntimeError("Target manifest does not contain the exact 32 stable slots")
    image_digests = local_image_digests(TARGET_DIR)
    if set(image_digests) != set(manifest_files):
        raise RuntimeError("Target directory files do not match the manifest")
    names = [item["source_image_name"] for item in current]
    urls = [item["source_url"] for item in current]
    rows = [item["source_row"] for item in current]
    prefixes = [item["prefix"] for item in current]
    digests = list(image_digests.values())
    for label, values in [("source row", rows), ("name", names), ("URL", urls), ("prefix", prefixes), ("pixels", digests)]:
        duplicates = [value for value, count in collections.Counter(values).items() if count > 1]
        if duplicates:
            raise RuntimeError(f"Duplicate target {label}: {duplicates}")
    blocked = state["blocked_non_targets"]
    for item in current:
        if item["source_image_name"] in blocked["names"]:
            raise RuntimeError(f"Target name collides with filler/vigilance: {item['source_image_name']}")
        if item["source_url"] in blocked["urls"]:
            raise RuntimeError(f"Target URL collides with filler/vigilance: {item['source_url']}")
        if item["prefix"] in blocked["prefixes"]:
            raise RuntimeError(f"Target prefix collides with filler/vigilance: {item['prefix']}")
        path = TARGET_DIR / item["dataset_filename"]
        with Image.open(path) as image:
            image.load()
            ratio = max(image.width / image.height, image.height / image.width)
        if ratio > 3.0:
            raise RuntimeError(f"Target exceeds aspect-ratio limit: {path.name} ({ratio:.6f})")
        if image_digests[path.name] != item["pixel_digest"]:
            raise RuntimeError(f"Target pixels differ from selection state: {path.name}")

    filler_manifest_path = FILLER_DIR / "manifest.json"
    filler_manifest = json.loads(filler_manifest_path.read_text())
    filler_files = list(filler_manifest.get("files", []))
    filler_digests = local_image_digests(FILLER_DIR)
    if len(filler_files) != 164 or set(filler_files) != set(filler_digests):
        raise RuntimeError("Filler directory/manifest does not contain the exact 164 stable files")
    if set(filler_digests.values()) != set(state["filler_pixel_digests"]):
        raise RuntimeError("Filler/vigilance image pixels changed after the initial snapshot")

    with LOCAL_SELECTION.open(newline="", encoding="utf-8") as handle:
        local_rows = list(csv.DictReader(handle))
    if len(local_rows) != 196:
        raise RuntimeError(f"Canonical local selection has {len(local_rows)} rows, expected 196")
    local_role_counts = collections.Counter(row["role"] for row in local_rows)
    if local_role_counts != {"target": 32, "vigilance_source": 12, "filler_single": 152}:
        raise RuntimeError(f"Canonical local selection role counts differ: {dict(local_role_counts)}")
    local_by_slot = {row["dataset_filename"]: row for row in local_rows if row["role"] == "target"}
    comparison_fields = [
        "level", "role", "level_position", "source_type", "source_sheet", "source_row",
        "source_index", "source_image_name", "source_image_id", "source_url",
        "dataset_filename", "final_vis_types", "dataset", "data_source",
    ]
    for item in current:
        row = local_by_slot.get(item["dataset_filename"])
        if row is None:
            raise RuntimeError(f"Canonical local selection is missing {item['dataset_filename']}")
        for field in comparison_fields:
            if str(row.get(field, "")) != str(item.get(field, "")):
                raise RuntimeError(f"Canonical local selection mismatch for {item['dataset_filename']} field {field}")

    with FINAL_SELECTION_PATH.open(newline="", encoding="utf-8") as handle:
        final_rows = list(csv.DictReader(handle))
    if len(final_rows) != 196:
        raise RuntimeError(f"v2 selection CSV has {len(final_rows)} rows, expected 196")
    expected_rows = [dict(zip(PILOT_HEADERS, row)) for row in state["current_values"][1:]]
    final_fields = list(final_rows[0])
    for row_number, (actual, expected) in enumerate(zip(final_rows, expected_rows), start=2):
        for field in final_fields:
            if str(actual.get(field, "")) != str(expected.get(field, "")):
                raise RuntimeError(f"v2 selection CSV mismatch at row {row_number}, field {field}")

    sheet_values_file = json.loads(SHEET_VALUES_PATH.read_text()).get("values", [])
    if normalize_values(sheet_values_file) != normalize_values(state["current_values"]):
        raise RuntimeError("Sheet-values JSON differs from current state")

    with TARGET_LEVEL_MAP.open(newline="", encoding="utf-8") as handle:
        map_rows = list(csv.DictReader(handle))
    if len(map_rows) != 32 or {row["filename"] for row in map_rows} != set(manifest_files):
        raise RuntimeError("Target level map does not contain the exact 32 stable slots")
    levels_by_slot = {item["dataset_filename"]: str(item["level"]) for item in current}
    for row in map_rows:
        if row.get("role") != "target" or row.get("level") != levels_by_slot[row["filename"]]:
            raise RuntimeError(f"Target level map mismatch for {row['filename']}")
    baseline = normalize_values(state["baseline_values"])
    current_values = normalize_values(state["current_values"])
    for index in range(1, len(baseline)):
        if baseline[index][3] != "target" and current_values[index] != baseline[index]:
            raise RuntimeError(f"Non-target row changed locally: {index + 1}")
    result = {
        "targets": 32,
        "type_counts": {category: counts[category] for category in CANONICAL_TYPES},
        "target_files_decodable": 32,
        "aspect_ratio_violations": 0,
        "target_duplicate_source_rows": 0,
        "target_duplicate_names": 0,
        "target_duplicate_urls": 0,
        "target_duplicate_prefixes": 0,
        "target_duplicate_pixels": 0,
        "non_target_rows_changed": 0,
        "filler_vigilance_files_unchanged": 164,
        "target_manifest_matches": True,
        "target_level_map_matches": True,
        "canonical_selection_csv_matches": True,
        "v2_selection_csv_matches": True,
        "sheet_values_json_matches": True,
    }
    return result


def verify(tab: str | None) -> None:
    state = load_state()
    local = validate_local(state)
    output: dict[str, Any] = {"local": local}
    if tab:
        readback = normalize_values(gog_get(f"'{tab}'!A1:Q197"))
        if readback != normalize_values(state["current_values"]):
            raise RuntimeError("Sheet/local state mismatch")
        verify_sheet_rows(state, readback)
        output["sheet"] = {
            "tab": tab,
            "rows": 196,
            "targets": 32,
            "vigilance_source": 12,
            "filler_single": 152,
            "exact_readback": True,
            "non_target_rows_unchanged": 164,
        }
    VALIDATION_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(output, ensure_ascii=False, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("prepare")
    replace_parser = subparsers.add_parser("replace")
    replace_parser.add_argument("--round", type=int, required=True)
    replace_parser.add_argument("--replace-slot", required=True)
    replace_parser.add_argument("--keep-slot", default="")
    replace_parser.add_argument("--reason", required=True)
    clean_parser = subparsers.add_parser("mark-review-clean")
    clean_parser.add_argument("--round", type=int, required=True)
    clean_parser.add_argument("--note", required=True)
    write_parser = subparsers.add_parser("write-sheet")
    write_parser.add_argument("--tab", default=OUTPUT_TAB)
    sync_parser = subparsers.add_parser("sync-sheet")
    sync_parser.add_argument("--tab", default=OUTPUT_TAB)
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--tab")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare()
    elif args.command == "replace":
        replace_one(args.round, args.replace_slot, args.keep_slot, args.reason)
    elif args.command == "mark-review-clean":
        mark_review_clean(args.round, args.note)
    elif args.command == "write-sheet":
        write_sheet(args.tab)
    elif args.command == "sync-sheet":
        sync_sheet_targets(args.tab)
    elif args.command == "verify":
        verify(args.tab)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
