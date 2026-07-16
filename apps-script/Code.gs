const HEADERS = [
  "event_type","timestamp_iso","user_id","participant_id","session_id","study_version",
  "level_index","trial_index","image_id","image_url","trial_type","is_repeat",
  "expected_response","participant_response","is_correct","rt_ms","repeat_lag",
  "vigilance_flag","false_alarm_flag","hit_flag","miss_flag","quality_gate_status",
  "quality_gate_reason","levels_completed","stop_after_level","pre_survey_submitted",
  "post_survey_submitted","pre_q1","pre_q2","pre_q3","pre_q4","pre_q5","post_q1",
  "post_q2","post_q3","post_q4","post_q5","post_q6","post_q7","post_q8",
  "client_meta_json","event_id"
];

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ensureSheet(ssId, wsName) {
  const ss = SpreadsheetApp.openById(ssId);
  const sh = ss.getSheetByName(wsName) || ss.getSheetByName("raw_events") || ss.getSheetByName("sheet1") || ss.getSheets()[0];
  if (sh.getMaxColumns() < HEADERS.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), HEADERS.length - sh.getMaxColumns());
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
  } else {
    const currentHeaders = sh.getRange(1, 1, 1, HEADERS.length).getValues()[0];
    const needsRepair = HEADERS.some((header, index) => currentHeaders[index] !== header);
    if (needsRepair) {
      sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    }
  }
  return sh;
}

function rowFromObj(obj) {
  return HEADERS.map(header => (
    obj && obj[header] !== undefined && obj[header] !== null ? String(obj[header]) : ""
  ));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function existingEventIds(sh, eventIds) {
  const ids = Array.from(new Set(eventIds.filter(Boolean).map(String)));
  if (!ids.length || sh.getLastRow() < 2) {
    return new Set();
  }
  const eventIdColumn = HEADERS.indexOf("event_id") + 1;
  const pattern = "^(?:" + ids.map(escapeRegex).join("|") + ")$";
  const matches = sh
    .getRange(2, eventIdColumn, sh.getLastRow() - 1, 1)
    .createTextFinder(pattern)
    .useRegularExpression(true)
    .matchEntireCell(true)
    .findAll();
  return new Set(matches.map(cell => String(cell.getValue())));
}

function legacyRow(payload) {
  const now = new Date().toISOString();
  return {
    event_type: "legacy_submit",
    timestamp_iso: now,
    user_id: payload.prolific_id || "",
    participant_id: payload.prolific_id || "",
    session_id: payload.session_id || ("legacy-" + Date.now()),
    study_version: payload.study_version || "pilot2-v1",
    client_meta_json: JSON.stringify(payload),
    event_id: ""
  };
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const body = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    const payload = JSON.parse(body);
    const ssId = payload.spreadsheet_id || "1i6SZGswHCEZjhYgxzQae5jjQDFowSl7jnA0IwYYcDVY";
    const worksheet = payload.worksheet_name || "raw_events";
    const sh = ensureSheet(ssId, worksheet);
    const receivedRows = Array.isArray(payload.rows) && payload.rows.length
      ? payload.rows
      : [legacyRow(payload)];

    const existing = existingEventIds(sh, receivedRows.map(row => row && row.event_id));
    const seenInPayload = new Set();
    const acceptedObjects = [];
    let duplicates = 0;

    receivedRows.forEach(row => {
      const eventId = row && row.event_id ? String(row.event_id) : "";
      if (eventId && (existing.has(eventId) || seenInPayload.has(eventId))) {
        duplicates++;
        return;
      }
      if (eventId) {
        seenInPayload.add(eventId);
      }
      acceptedObjects.push(row);
    });

    if (acceptedObjects.length) {
      const values = acceptedObjects.map(rowFromObj);
      sh.getRange(sh.getLastRow() + 1, 1, values.length, HEADERS.length).setValues(values);
    }

    return jsonOut({
      ok: true,
      received: receivedRows.length,
      appended: acceptedObjects.length,
      duplicates: duplicates,
      sheet: ssId + ":" + sh.getName()
    });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  } finally {
    if (lock.hasLock()) {
      lock.releaseLock();
    }
  }
}
