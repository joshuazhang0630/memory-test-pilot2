"""Score the balanced study from one or more raw_events CSV exports."""

import argparse
import csv
import json
import math
from pathlib import Path
from statistics import NormalDist


STUDY_VERSION = "pilot2-balanced-slots-v1"
CATALOG = Path(__file__).resolve().parents[1] / "stimulus-catalog.json"
REQUIRED = {
    "event_type", "timestamp_iso", "participant_id", "session_id", "study_version",
    "level_index", "image_id", "trial_type", "participant_response",
    "quality_gate_status", "client_meta_json",
}


def read_sessions(files, catalog_version, filenames):
    sessions = {}
    for filename in files:
        with filename.open(newline="", encoding="utf-8-sig") as source:
            rows = csv.DictReader(source)
            missing = REQUIRED.difference(rows.fieldnames or [])
            if missing:
                raise ValueError(f"{filename} is missing columns {sorted(missing)}")
            for row in rows:
                if row["study_version"] != STUDY_VERSION or row["participant_id"].startswith("QA_"):
                    continue
                failed = row["quality_gate_status"].startswith("failed")
                role = row["trial_type"]
                if not failed and row["event_type"] != "trial":
                    continue
                meta = json.loads(row["client_meta_json"] or "{}")
                slot = meta.get("slot_id")
                if meta.get("run_mode") == "qa":
                    continue
                if not slot or meta.get("plan_version") != STUDY_VERSION or (
                    meta.get("stimulus_catalog_version") != catalog_version
                ):
                    raise ValueError("Balanced study row lacks matching slot metadata")
                key = (slot, row["session_id"])
                session = sessions.setdefault(key, {"failed": False, "earliest": None, "pairs": {}})
                session["failed"] |= failed
                if row["event_type"] != "trial":
                    continue
                timestamp = row["timestamp_iso"]
                if session["earliest"] is None or timestamp < session["earliest"]:
                    session["earliest"] = timestamp
                if role not in ("target_first", "target_repeat"):
                    continue
                level = int(row["level_index"])
                image = filenames[row["image_id"]]
                response = int(row["participant_response"])
                if level not in range(1, 6) or response not in (0, 1):
                    raise ValueError(f"Invalid target response in {key}")
                pair = session["pairs"].setdefault((image, level), {})
                if pair.setdefault(role, response) != response:
                    raise ValueError(f"Conflicting target response in {key} for {image}")
    return sessions


def wilson(successes, total):
    if not total:
        return "", ""
    z = 1.959963984540054
    rate = successes / total
    scale = 1 + z * z / total
    center = (rate + z * z / (2 * total)) / scale
    half = z * math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total)) / scale
    return max(0, center - half), min(1, center + half)


def summarize(files):
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    filenames = {Path(image["filename"]).stem: image["filename"] for image in catalog["images"]}
    sessions = read_sessions(files, catalog["version"], filenames)
    first_by_slot = {}
    for (slot, session_id), session in sessions.items():
        if session["earliest"] is not None:
            order = (session["earliest"], session_id)
            if slot not in first_by_slot or order < first_by_slot[slot][0]:
                first_by_slot[slot] = (order, session)

    names = list(filenames.values())
    coverage = {name: [0] * 5 for name in names}
    hits = dict.fromkeys(names, 0)
    false_alarms = dict.fromkeys(names, 0)
    for _, session in first_by_slot.values():
        if session["failed"]:
            continue
        for (image, level), pair in session["pairs"].items():
            if len(pair) == 2:
                coverage[image][level - 1] += 1
                hits[image] += pair["target_repeat"]
                false_alarms[image] += pair["target_first"]

    normal = NormalDist()
    scores = []
    for name in names:
        total = sum(coverage[name])
        hit, fa = hits[name], false_alarms[name]
        hr_lo, hr_hi = wilson(hit, total)
        far_lo, far_hi = wilson(fa, total)
        corrected = (
            normal.inv_cdf((hit + 0.5) / (total + 1)) - normal.inv_cdf((fa + 0.5) / (total + 1))
            if total else ""
        )
        scores.append({
            "filename": name,
            "valid_pairs": total,
            "hits": hit,
            "misses": total - hit,
            "false_alarms": fa,
            "correct_rejections": total - fa,
            "HR": hit / total if total else "",
            "FAR": fa / total if total else "",
            "HR_ci_low": hr_lo,
            "HR_ci_high": hr_hi,
            "FAR_ci_low": far_lo,
            "FAR_ci_high": far_hi,
            "d_prime_corrected": corrected,
        })
    return {
        "study_version": STUDY_VERSION,
        "catalog_version": catalog["version"],
        "pairs_by_level": coverage,
    }, scores


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("raw_events", nargs="+", type=Path)
    parser.add_argument("--coverage", required=True, type=Path)
    parser.add_argument("--scores", required=True, type=Path)
    args = parser.parse_args()
    coverage, scores = summarize(args.raw_events)
    with args.coverage.open("x", encoding="utf-8") as output:
        json.dump(coverage, output, indent=2)
        output.write("\n")
    with args.scores.open("x", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=list(scores[0]))
        writer.writeheader()
        writer.writerows(scores)
    total = sum(row["valid_pairs"] for row in scores)
    print(f"{len(scores)} images, {total} valid target pairs")


if __name__ == "__main__":
    main()
