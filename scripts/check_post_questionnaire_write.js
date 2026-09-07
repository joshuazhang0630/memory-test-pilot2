const assert = require('assert');
const { execFileSync } = require('child_process');

const spreadsheetId = '1i6SZGswHCEZjhYgxzQae5jjQDFowSl7jnA0IwYYcDVY';
const appsUrl = 'https://script.google.com/macros/s/AKfycbxy8Li7LKoIZK30w0ivOeQUqfmWTBWWLfMxBqByQjlWCAkJJPYucQLh7Pp0Vc_Pa3I1jg/exec';
const tag = `QA_POST_${Date.now()}`;
const hitImageId = `${tag}_HIT_IMAGE`;
const missImageId = `${tag}_MISS_IMAGE`;

const expected = {
  post_q1: `${tag} hit description`,
  post_q2: `${tag} hit features`,
  post_q3: `${tag} miss description`,
  post_q4: `${tag} miss features`,
  post_q5: hitImageId,
  post_q6: missImageId,
  post_q7: `${tag} study comments`,
  post_q8: 'target-hit-miss-v1',
};

const postRaw = {
  version: expected.post_q8,
  hitImageId,
  hitImageUrl: `https://example.test/${hitImageId}.png`,
  hitDescription: expected.post_q1,
  hitFeatures: expected.post_q2,
  missImageId,
  missImageUrl: `https://example.test/${missImageId}.png`,
  missDescription: expected.post_q3,
  missFeatures: expected.post_q4,
  studyComments: expected.post_q7,
};

const row = {
  event_type: 'session_end',
  event_id: `${tag}:session_end`,
  timestamp_iso: new Date().toISOString(),
  user_id: tag,
  participant_id: tag,
  session_id: tag,
  study_version: 'pilot2-v1',
  level_index: 2,
  trial_index: '',
  image_id: '',
  image_url: '',
  trial_type: '',
  is_repeat: '',
  expected_response: '',
  participant_response: '',
  is_correct: '',
  rt_ms: '',
  repeat_lag: '',
  vigilance_flag: '',
  false_alarm_flag: '',
  hit_flag: '',
  miss_flag: '',
  quality_gate_status: 'completed',
  quality_gate_reason: '',
  levels_completed: 2,
  stop_after_level: '',
  pre_survey_submitted: 1,
  post_survey_submitted: 1,
  pre_q1: 'no',
  pre_q2: 'qa',
  pre_q3: '26-35',
  pre_q4: 'Graduate school',
  pre_q5: `${tag} pre-survey marker`,
  ...expected,
  client_meta_json: JSON.stringify({
    run_mode: 'qa',
    schema_version: 'pilot2-event-v3',
    stimulus_catalog_version: 'pilot2_balanced_targets_v2',
    client_build_id: 'pilot2-post-questionnaire-v5',
    post_raw: postRaw,
  }),
};

function readRawEvents() {
  const output = execFileSync(
    'gog',
    ['sheets', 'get', spreadsheetId, 'raw_events!A:AP', '--json', '--results-only'],
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
  );
  return JSON.parse(output);
}

function findWrittenRow(values) {
  const headers = values[0] || [];
  const eventIdIndex = headers.indexOf('event_id');
  const data = values.find((candidate, index) => index > 0 && candidate[eventIdIndex] === row.event_id);
  if (!data) return null;
  return Object.fromEntries(headers.map((header, index) => [header, data[index] === undefined ? '' : data[index]]));
}

async function main() {
  const response = await fetch(appsUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      spreadsheet_id: spreadsheetId,
      worksheet_name: 'raw_events',
      schema_version: 'pilot2-event-v3',
      rows: [row],
      chunk_index: 0,
      chunk_total: 1,
      prolific_id: tag,
    }),
  });
  assert.strictEqual(response.ok, true, `Apps Script returned HTTP ${response.status}`);
  const acknowledgement = await response.json();
  assert.strictEqual(acknowledgement.ok, true);
  assert.strictEqual(Number(acknowledgement.received), 1);
  assert.strictEqual(Number(acknowledgement.appended) + Number(acknowledgement.duplicates), 1);

  let written = null;
  for (let attempt = 0; attempt < 5 && !written; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
    written = findWrittenRow(readRawEvents());
  }
  assert(written, 'QA post-questionnaire row was not found in raw_events');
  for (const [field, value] of Object.entries(expected)) {
    assert.strictEqual(written[field], value, `${field} did not round-trip through Apps Script`);
  }
  assert.strictEqual(written.post_survey_submitted, '1');
  const writtenMeta = JSON.parse(written.client_meta_json);
  assert.deepStrictEqual(writtenMeta.post_raw, postRaw);
  assert.strictEqual(writtenMeta.schema_version, 'pilot2-event-v3');
  assert.strictEqual(writtenMeta.client_build_id, 'pilot2-post-questionnaire-v5');

  console.log(JSON.stringify({
    status: 'PASS',
    qaSessionId: tag,
    sheet: 'raw_events',
    verifiedFields: Object.keys(expected).concat(['post_survey_submitted', 'client_meta_json.post_raw']),
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
