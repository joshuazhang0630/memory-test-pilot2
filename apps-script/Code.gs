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
const SPREADSHEET_ID = "1i6SZGswHCEZjhYgxzQae5jjQDFowSl7jnA0IwYYcDVY";
const SLOT_HEADERS = ["slot_id", "plan_version", "catalog_version", "targets_json", "participant_key"];
const SLOT_PLAN_VERSION = "pilot2-balanced-slots-v1";
const SLOT_CATALOG_VERSION = "pilot2_shared_targets_1800_v1";

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ensureSheet(ssId, wsName, requireName) {
  const ss = SpreadsheetApp.openById(ssId);
  const sh = ss.getSheetByName(wsName) || (!requireName &&
    (ss.getSheetByName("raw_events") || ss.getSheetByName("sheet1") || ss.getSheets()[0]));
  if (!sh) {
    throw new Error("Missing worksheet " + wsName);
  }
  if (sh.getName() === "target_slots") {
    throw new Error("Cannot write raw events to target_slots");
  }
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

// Called while holding the script lock, including the final spreadsheet flush.
function claimTargetSlot(payload) {
  const participantId = typeof payload.participant_id === "string" ? payload.participant_id.trim() : "";
  if (!participantId || participantId.length > 200 || /^QA_/.test(participantId)) {
    return {ok: false, code: "invalid_participant_id"};
  }
  if (payload.plan_version !== SLOT_PLAN_VERSION || payload.catalog_version !== SLOT_CATALOG_VERSION) {
    return {ok: false, code: "target_slot_version_mismatch"};
  }
  const controlId = PropertiesService.getScriptProperties().getProperty("PILOT2_SLOT_WORKBOOK") || SPREADSHEET_ID;
  const sheet = SpreadsheetApp.openById(controlId).getSheetByName("target_slots");
  if (!sheet || sheet.getLastRow() < 2 ||
      !sheet.getRange(1, 1, 1, SLOT_HEADERS.length).getValues()[0]
        .every((header, index) => header === SLOT_HEADERS[index])) {
    return {ok: false, code: "target_slot_plan_unavailable"};
  }

  // JSON keeps inputs such as 0012 and =... as literal strings in Sheets.
  const key = JSON.stringify(participantId);
  const bindings = sheet.getRange(2, 5, sheet.getLastRow() - 1, 1).getValues().map(row => row[0]);
  const existing = bindings.indexOf(key);
  const index = existing === -1 ? bindings.indexOf("") : existing;
  if (index === -1) {
    return {ok: false, code: "target_slots_full"};
  }
  const row = index + 2;
  const [slotId, planVersion, catalogVersion, targetsJson] = sheet.getRange(row, 1, 1, 4).getValues()[0];
  const targets = JSON.parse(targetsJson || "null");
  if (!/^[WT]\d+-\d+$/.test(slotId) || planVersion !== SLOT_PLAN_VERSION || catalogVersion !== SLOT_CATALOG_VERSION ||
      !Array.isArray(targets) || targets.length !== 5 ||
      !targets.every(level => Array.isArray(level) && level.length === 16) ||
      !targets.flat().every(filename => typeof filename === "string" && filename.endsWith(".png")) ||
      new Set(targets.flat()).size !== 80) {
    return {ok: false, code: "invalid_target_slot"};
  }
  if (existing === -1) {
    sheet.getRange(row, 5).setValue(key);
    SpreadsheetApp.flush();
  }
  return {ok: true, slot_id: slotId, plan_version: planVersion, catalog_version: catalogVersion, targets};
}

function balancedRawWorkbook(rows) {
  const first = rows[0];
  if (!first || first.study_version !== SLOT_PLAN_VERSION) {
    return "";
  }
  const metadata = JSON.parse(first.client_meta_json || "{}");
  if (metadata.run_mode === "qa") {
    return "";
  }
  const config = PropertiesService.getScriptProperties().getProperty("PILOT2_RAW_WORKBOOKS");
  if (!config) {
    return "";
  }
  const batch = String(metadata.slot_id || "").split("-")[0];
  const id = JSON.parse(config)[batch];
  if (!/^[WT]\d+$/.test(batch) || typeof id !== "string" || !id ||
      !rows.every(row => row.study_version === SLOT_PLAN_VERSION && row.session_id === first.session_id &&
        JSON.parse(row.client_meta_json || "{}").slot_id === metadata.slot_id)) {
    throw new Error("Missing raw_events workbook or inconsistent session slot");
  }
  return id;
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const body = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    const payload = JSON.parse(body);
    if (payload.action === "claim_target_slot") {
      return jsonOut(claimTargetSlot(payload));
    }
    const receivedRows = Array.isArray(payload.rows) && payload.rows.length
      ? payload.rows
      : [legacyRow(payload)];
    const requestedWorksheet = payload.worksheet_name || "raw_events";
    if ((payload.spreadsheet_id && payload.spreadsheet_id !== SPREADSHEET_ID) ||
        !["raw_events", "sheet1"].includes(requestedWorksheet)) {
      return jsonOut({ok: false, code: "reserved_worksheet"});
    }
    const rawWorkbook = balancedRawWorkbook(receivedRows);
    const ssId = rawWorkbook || SPREADSHEET_ID;
    const worksheet = rawWorkbook ? "raw_events" : requestedWorksheet;
    const sh = ensureSheet(ssId, worksheet, Boolean(rawWorkbook));

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
      const firstRow = sh.getLastRow() + 1;
      const currentGrid = sh.getMaxRows();
      const extra = firstRow + values.length - 1 - currentGrid;
      if (extra > 0) {
        sh.insertRowsAfter(currentGrid, extra);
      }
      sh.getRange(firstRow, 1, values.length, HEADERS.length).setValues(values);
      SpreadsheetApp.flush();
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
