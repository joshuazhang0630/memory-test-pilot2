#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SID="1i6SZGswHCEZjhYgxzQae5jjQDFowSl7jnA0IwYYcDVY"
APPS_URL="https://script.google.com/macros/s/AKfycbxy8Li7LKoIZK30w0ivOeQUqfmWTBWWLfMxBqByQjlWCAkJJPYucQLh7Pp0Vc_Pa3I1jg/exec"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TAG="backend_sheet_smoke_$(date +%s)_${RANDOM}"
PAYLOAD=$(mktemp)
trap 'rm -f "$PAYLOAD"' EXIT

python3 - "$PAYLOAD" "$TAG" "$TS" "$SID" <<'PY'
import json
import sys

path, tag, ts, sid = sys.argv[1:5]
row = {
    "event_type": "smoke_test",
    "event_id": tag,
    "timestamp_iso": ts,
    "user_id": "system",
    "participant_id": "system",
    "session_id": tag,
    "study_version": "pilot2-v1",
    "level_index": "",
    "trial_index": "",
    "image_id": "",
    "image_url": "",
    "trial_type": "",
    "is_repeat": "",
    "expected_response": "",
    "participant_response": "",
    "is_correct": "",
    "rt_ms": "",
    "repeat_lag": "",
    "vigilance_flag": "",
    "false_alarm_flag": "",
    "hit_flag": "",
    "miss_flag": "",
    "quality_gate_status": "ok",
    "quality_gate_reason": "",
    "levels_completed": "0",
    "stop_after_level": "",
    "pre_survey_submitted": "0",
    "post_survey_submitted": "0",
    "pre_q1": "",
    "pre_q2": "",
    "pre_q3": "",
    "pre_q4": "",
    "pre_q5": "",
    "post_q1": "",
    "post_q2": "",
    "post_q3": "",
    "post_q4": "",
    "post_q5": "",
    "post_q6": "",
    "post_q7": "",
    "post_q8": "",
    "client_meta_json": json.dumps({"tag": tag, "source": "check_sheet_write.sh"}),
}
payload = {
    "spreadsheet_id": sid,
    "worksheet_name": "raw_events",
    "schema_version": "pilot2-event-v2",
    "rows": [row],
    "chunk_index": 0,
    "chunk_total": 1,
    "prolific_id": "system",
}
with open(path, "w") as f:
    json.dump(payload, f)
PY

curl -fsS -X POST -H "Content-Type: text/plain;charset=utf-8" --data-binary "@$PAYLOAD" "$APPS_URL" >/tmp/sheet_backend_out.txt
sleep 3

RAW=$(gog sheets get "$SID" "raw_events!A:AP" --json)
echo "$RAW" > "$REPO/reports/step3_data_integrity.json"
echo "$RAW" | grep -q "$TAG"
echo "backend_sheet_write_ok tag=$TAG"
