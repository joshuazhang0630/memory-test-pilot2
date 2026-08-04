#!/usr/bin/env python3
"""Replace the anime vigilance slot with the reviewed VIS30K fluid surface."""

from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import json
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
DATASET = ROOT / "dataset"
BACKUPS = ROOT / "dataset_backups"
SLOT = "I362Y2015_SciVisJ.926.3.png"
REVISION = "2026-08-04-anime-swap-1"
SEED = "pilot2-anime-vigilance-replacement-2026-08-04"
LIVE_SHEET_ROWS = {"pilot2_balanced_targets_v2": 64, "pilot2_dataset_06_18": 155}

OLD = {
    "source_row": "599",
    "source_image_id": "I7318Y2020",
    "source_image_name": "InfoVisJ.924.3.png",
    "source_url": "https://3.15.237.155/VIS30K/Images/2020/InfoVisJ.924.3.png",
    "data_source": "InfoVis",
}

NEW = {
    "source_type": "filler",
    "source_sheet": "all_fillers_single",
    "source_row": "439",
    "source_index": "",
    "source_image_id": "I136Y2005",
    "source_image_name": "VisC.127.6.png",
    "source_url": "https://3.15.237.155/VIS30K/Images/2005/VisC.127.6.png",
    "final_vis_types": "Surface/Volume",
    "dataset": "",
    "data_source": "Vis",
    "random_seed": SEED,
}

SELECTION_FILES = [
    DATASET / "pilot2_dataset_selection_2026_06_17.csv",
    DATASET / "pilot2_balanced_targets_v2_selection.csv",
]
SHEET_VALUES = DATASET / "pilot2_balanced_targets_v2_sheet_values.json"
STATE = DATASET / "pilot2_balanced_targets_v2_state.json"
MANIFEST = DATASET / "filler" / "manifest.json"
TARGET_IMAGE = DATASET / "filler" / SLOT
AUDIT = DATASET / "pilot2_anime_vigilance_replacement_2026_08_04.csv"
SUMMARY = DATASET / "pilot2_anime_vigilance_replacement_2026_08_04_summary.json"


def image_prefix(name: str) -> str:
    base = os.path.basename(str(name or "").strip())
    parts = base.split(".")
    return ".".join(parts[:2]) if len(parts) >= 3 else os.path.splitext(base)[0]


def pixel_digest(image: Image.Image) -> str:
    rgb = image.convert("RGB")
    digest = hashlib.sha256()
    digest.update(f"{rgb.width}x{rgb.height}|".encode())
    digest.update(rgb.tobytes())
    return digest.hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def dhash(image: Image.Image) -> int:
    grayscale = image.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    pixels = list(grayscale.get_flattened_data())
    value = 0
    for row in range(8):
        for column in range(8):
            if pixels[row * 9 + column] > pixels[row * 9 + column + 1]:
                value |= 1 << (row * 8 + column)
    return value


def load_clean_source(composite_path: Path, caption_path: Path) -> Image.Image:
    with Image.open(composite_path) as composite_source, Image.open(caption_path) as caption_source:
        composite_source.load()
        caption_source.load()
        if composite_source.width != caption_source.width:
            raise RuntimeError("Source and caption widths differ; refusing an uncertain crop")
        clean_height = composite_source.height - caption_source.height
        if clean_height <= 0:
            raise RuntimeError("Caption is not smaller than the source image")
        return composite_source.convert("RGBA").crop((0, 0, composite_source.width, clean_height))


def existing_images() -> list[Path]:
    paths: list[Path] = []
    for directory in [DATASET / "target", DATASET / "filler", ROOT / "tmp" / "pretrain_image_probe_cache"]:
        if not directory.exists():
            continue
        for path in sorted(directory.glob("*.png")):
            if path.resolve() != TARGET_IMAGE.resolve():
                paths.append(path)
    return paths


def validate_candidate(image: Image.Image) -> list[dict[str, Any]]:
    ratio = max(image.width / image.height, image.height / image.width)
    if ratio > 3.0:
        raise RuntimeError(f"Candidate aspect ratio is {ratio:.6f}, above 3.0")

    candidate_digest = pixel_digest(image)
    candidate_hash = dhash(image)
    nearest: list[dict[str, Any]] = []
    exact_matches: list[str] = []
    for path in existing_images():
        with Image.open(path) as source:
            source.load()
            if pixel_digest(source) == candidate_digest:
                exact_matches.append(str(path))
            distance = (candidate_hash ^ dhash(source)).bit_count()
        nearest.append({"distance": distance, "filename": path.name, "path": str(path)})
    if exact_matches:
        raise RuntimeError(f"Candidate duplicates existing pixels: {exact_matches}")
    nearest.sort(key=lambda row: (row["distance"], row["filename"]))
    if nearest and nearest[0]["distance"] <= 8:
        raise RuntimeError(f"Candidate dHash distance {nearest[0]['distance']} is at or below 8")
    return nearest[:10]


def read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def write_csv(path: Path, fields: list[str], rows: list[dict[str, str]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def validate_source_uniqueness() -> None:
    _, rows = read_csv(DATASET / "pilot2_balanced_targets_v2_selection.csv")
    other = [row for row in rows if row.get("dataset_filename") != SLOT]
    checks = {
        "source_row": NEW["source_row"],
        "source_image_id": NEW["source_image_id"],
        "source_image_name": NEW["source_image_name"],
        "source_url": NEW["source_url"],
    }
    for field, value in checks.items():
        if any(row.get(field, "") == value for row in other):
            raise RuntimeError(f"Candidate {field} is already used: {value}")
    prefix = image_prefix(NEW["source_image_name"])
    if any(image_prefix(row.get("source_image_name", "")) == prefix for row in other):
        raise RuntimeError(f"Candidate prefix is already used: {prefix}")


def update_selection_csv(path: Path) -> None:
    fields, rows = read_csv(path)
    matches = [row for row in rows if row.get("dataset_filename") == SLOT]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one {SLOT} row in {path.name}, found {len(matches)}")
    row = matches[0]
    if row.get("source_image_name") not in {OLD["source_image_name"], NEW["source_image_name"]}:
        raise RuntimeError(f"Unexpected existing source in {path.name}: {row.get('source_image_name')}")
    for field, value in NEW.items():
        if field in fields:
            row[field] = value
    write_csv(path, fields, rows)


def update_values(values: list[list[Any]]) -> int:
    if not values:
        raise RuntimeError("Sheet values are empty")
    header = [str(cell) for cell in values[0]]
    index = {name: position for position, name in enumerate(header)}
    slot_index = index["dataset_filename"]
    matches = [row for row in values[1:] if len(row) > slot_index and str(row[slot_index]) == SLOT]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one {SLOT} row in sheet values, found {len(matches)}")
    row = matches[0]
    if len(row) < len(header):
        row.extend([""] * (len(header) - len(row)))
    for field, value in NEW.items():
        if field in index:
            row[index[field]] = value
    return values.index(row) + 1


def replace_sorted_value(values: list[str], old: str, new: str) -> list[str]:
    result = [value for value in values if value != old]
    if new and new not in result:
        result.append(new)
    return sorted(result)


def backup_files() -> Path:
    BACKUPS.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    destination = BACKUPS / f"dataset_before_anime_vigilance_replacement_{stamp}"
    destination.mkdir()
    for path in [TARGET_IMAGE, MANIFEST, *SELECTION_FILES, SHEET_VALUES, STATE]:
        shutil.copy2(path, destination / path.name)
    return destination


def apply(composite_path: Path, caption_path: Path) -> dict[str, Any]:
    validate_source_uniqueness()
    clean = load_clean_source(composite_path, caption_path)
    nearest = validate_candidate(clean)
    backup = backup_files()

    old_pixel_digest: str
    with Image.open(TARGET_IMAGE) as old_image:
        old_image.load()
        old_pixel_digest = pixel_digest(old_image)
    old_file_sha = file_sha256(TARGET_IMAGE)

    temporary = TARGET_IMAGE.with_suffix(".replacement.tmp.png")
    clean.save(temporary, format="PNG", optimize=True)
    temporary.replace(TARGET_IMAGE)
    new_pixel_digest = pixel_digest(clean)
    new_file_sha = file_sha256(TARGET_IMAGE)

    for path in SELECTION_FILES:
        update_selection_csv(path)

    sheet_payload = json.loads(SHEET_VALUES.read_text())
    balanced_sheet_row = update_values(sheet_payload["values"])
    SHEET_VALUES.write_text(json.dumps(sheet_payload, ensure_ascii=False, indent=2) + "\n")

    state = json.loads(STATE.read_text())
    current_row = update_values(state["current_values"])
    baseline_row = update_values(state["baseline_values"])
    blocked = state["blocked_non_targets"]
    blocked["names"] = replace_sorted_value(blocked.get("names", []), OLD["source_image_name"], NEW["source_image_name"])
    blocked["urls"] = replace_sorted_value(blocked.get("urls", []), OLD["source_url"], NEW["source_url"])
    blocked["ids"] = replace_sorted_value(blocked.get("ids", []), OLD["source_image_id"], NEW["source_image_id"])
    blocked["prefixes"] = replace_sorted_value(blocked.get("prefixes", []), image_prefix(OLD["source_image_name"]), image_prefix(NEW["source_image_name"]))
    state["filler_pixel_digests"] = replace_sorted_value(state.get("filler_pixel_digests", []), old_pixel_digest, new_pixel_digest)
    state["anime_vigilance_replacement"] = {
        "revision": REVISION,
        "stable_slot": SLOT,
        "old": OLD,
        "new": NEW,
        "nearest_dhash": nearest,
    }
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")

    manifest = json.loads(MANIFEST.read_text())
    if SLOT not in manifest.get("files", []):
        raise RuntimeError(f"Filler manifest is missing {SLOT}")
    manifest["revision"] = REVISION
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    audit_fields = [
        "pilot_tab", "pilot_sheet_row", "level", "role", "level_position", "dataset_filename",
        "old_source_row", "old_source_image_id", "old_source_image_name", "old_prefix",
        "new_source_row", "new_source_image_id", "new_source_image_name", "new_prefix", "new_source_url",
        "width", "height", "aspect_ratio", "dhash", "nearest_dhash_distance", "revision", "seed",
    ]
    common = {
        "level": "2", "role": "vigilance_source", "level_position": "3", "dataset_filename": SLOT,
        "old_source_row": OLD["source_row"], "old_source_image_id": OLD["source_image_id"],
        "old_source_image_name": OLD["source_image_name"], "old_prefix": image_prefix(OLD["source_image_name"]),
        "new_source_row": NEW["source_row"], "new_source_image_id": NEW["source_image_id"],
        "new_source_image_name": NEW["source_image_name"], "new_prefix": image_prefix(NEW["source_image_name"]),
        "new_source_url": NEW["source_url"], "width": clean.width, "height": clean.height,
        "aspect_ratio": f"{max(clean.width / clean.height, clean.height / clean.width):.6f}",
        "dhash": f"{dhash(clean):016x}", "nearest_dhash_distance": nearest[0]["distance"],
        "revision": REVISION, "seed": SEED,
    }
    audit_rows = [
        {**common, "pilot_tab": "pilot2_balanced_targets_v2", "pilot_sheet_row": LIVE_SHEET_ROWS["pilot2_balanced_targets_v2"]},
        {**common, "pilot_tab": "pilot2_dataset_06_18", "pilot_sheet_row": LIVE_SHEET_ROWS["pilot2_dataset_06_18"]},
    ]
    write_csv(AUDIT, audit_fields, audit_rows)

    summary = {
        "status": "applied",
        "backup_dir": str(backup),
        "stable_slot": SLOT,
        "old_file_sha256": old_file_sha,
        "new_file_sha256": new_file_sha,
        "old_pixel_digest": old_pixel_digest,
        "new_pixel_digest": new_pixel_digest,
        "candidate": NEW,
        "width": clean.width,
        "height": clean.height,
        "aspect_ratio": max(clean.width / clean.height, clean.height / clean.width),
        "dhash": f"{dhash(clean):016x}",
        "nearest_dhash": nearest,
        "manifest_revision": REVISION,
        "local_state_rows": {"current_values": current_row, "baseline_values": baseline_row},
        "sheet_rows": LIVE_SHEET_ROWS,
        "role_counts_expected": {"target": 32, "vigilance_source": 12, "filler_single": 152},
    }
    SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--composite", type=Path, required=True)
    parser.add_argument("--caption", type=Path, required=True)
    args = parser.parse_args()
    summary = apply(args.composite.resolve(), args.caption.resolve())
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
