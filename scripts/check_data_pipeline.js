const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const base = path.resolve(__dirname, '..');
const elements = new Map();

function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id,
      value: '',
      innerHTML: '',
      textContent: '',
      disabled: false,
      style: {},
      setAttribute() {},
      addEventListener() {},
      querySelector() { return null; },
      reportValidity() { return true; },
    });
  }
  return elements.get(id);
}

const localData = new Map();
const ctx = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  JSON,
  Promise,
  Blob,
  alert() {},
  navigator: {},
  localStorage: {
    setItem(key, value) { localData.set(key, value); },
    getItem(key) { return localData.get(key) || null; },
    removeItem(key) { localData.delete(key); },
  },
  FormData: class FormDataStub {
    entries() { return [['study_comments', element('study-comments').value]]; }
  },
  document: {
    onkeydown: null,
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById: element,
    body: { innerHTML: '' },
  },
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(base, file), 'utf8'), ctx, { filename: file });
}

load('state.js');
load('utils.js');
load('ui.js');
load('data.js');
load('experiment.js');
load('survey.js');

function resetSession() {
  ctx.pid = 'QA_PIPELINE';
  ctx.currentSessionId = 'QA_PIPELINE-session';
  ctx.currentLevelKey = '1';
  ctx.completedLevels = ['1', '2'];
  ctx.endingStatus = 'completed';
  ctx.stopAfterLevel = '';
  ctx.kickedOut = 0;
  ctx.falsealarmcounts = 0;
  ctx.vigilancefails = 0;
  ctx.vigilanceHistory = [];
  ctx.trialEventRows = [];
  ctx.savedProgressKeys = {};
  ctx.trialOnsetTimestamps = [];
  ctx.trialResponseTimes = [];
  ctx.trialResponseWindows = [];
  ctx.imgstring = '';
  ctx.imtypestring = '';
  ctx.perfstring = '';
  ctx.sequenceContext = {
    algorithm: 'pilot2-session-sequence-v2',
    seedInput: 'pipeline-seed-input',
    seedHash: 'a1b2c3d4',
    assignmentHash: 'e5f60718',
    levelSequenceHashes: { '1': '11111111', '2': '22222222' },
  };
  ctx.preSurveyResponses = {
    workerId: 'QA_PIPELINE',
    takenBefore: 'no',
    gender: 'other',
    genderSelf: 'pipeline-self-description',
    age: '26-35',
    education: 'Graduate school',
    complexVizDesc: 'pipeline pre survey marker',
  };
  ctx.postSurveyResponses = {
    rememberedImage: '',
    rememberFeaturesA: 'pipeline post A',
    rememberFeaturesB: 'pipeline post B',
    studyComments: 'pipeline comments',
  };
  element('endingout').value = 'completed';
  element('study-comments').value = 'pipeline comments';
}

function setTinyLevel(level, imageName) {
  ctx.currentLevelKey = String(level);
  ctx.fullsequence = [`https://example.test/${imageName}`, ctx.fixation_address];
  ctx.typesequence = [1, 0];
  ctx.perfsequence = [14, 0];
  ctx.trialOnsetTimestamps = [Date.now() - 1000, Date.now()];
  ctx.trialResponseTimes = [];
  ctx.trialResponseWindows = [];
}

async function main() {
  resetSession();

  ctx.devFastMode = true;
  ctx.devPretrainUniqueCount = 2;
  ctx.devPretrainTotalCount = 4;
  ctx.pretestImages = ['practice-a.png', 'practice-b.png'];
  ctx.buildPretrainSequence();
  assert.deepStrictEqual(Array.from(ctx.pretrainTypeSequence), [1, 1, 2, 2]);
  assert.strictEqual(ctx.pretrainSequence[0], ctx.pretrainSequence[2]);
  assert.strictEqual(ctx.pretrainSequence[1], ctx.pretrainSequence[3]);
  ctx.devFastMode = false;

  setTinyLevel(1, 'level1.png');
  ctx.saveProgress(0);
  ctx.saveProgress(1);
  setTinyLevel(2, 'level2.png');
  ctx.saveProgress(0);
  ctx.saveProgress(1);

  assert.deepStrictEqual(
    ctx.imgstring.split(','),
    ['level1.png', 'fixation.jpg', 'level2.png', 'fixation.jpg'],
    'level boundary must retain commas'
  );
  assert.strictEqual(ctx.imtypestring.split(',').length, 4);
  assert.strictEqual(ctx.perfstring.split(',').length, 4);
  assert.strictEqual(ctx.trialEventRows.length, 2);
  assert.notStrictEqual(ctx.trialEventRows[0].event_id, ctx.trialEventRows[1].event_id);
  assert.match(ctx.trialEventRows[0].event_id, /:level:1:trial:0$/);
  assert.match(ctx.trialEventRows[1].event_id, /:level:2:trial:0$/);

  resetSession();
  setTinyLevel(1, 'late-response.png');
  ctx.imCount = 1;
  ctx.trialOnsetTimestamps[0] = Date.now() - 2100;
  ctx.processResponse({ code: 'Space', preventDefault() {} });
  assert.strictEqual(ctx.perfsequence[0], 13, 'fixation response must update preceding image');
  assert.strictEqual(ctx.perfsequence[1], 0, 'fixation slot must remain untouched');
  assert.strictEqual(ctx.trialResponseWindows[0], 'fixation_grace');
  assert(ctx.trialResponseTimes[0] >= 2000);
  ctx.finalizeTrialPair(0, 1);
  assert.strictEqual(ctx.falsealarmcounts, 1);
  assert.strictEqual(ctx.trialEventRows.length, 1);
  assert.strictEqual(ctx.trialEventRows[0].participant_response, 1);
  assert.strictEqual(ctx.trialEventRows[0].false_alarm_flag, 1);
  const trialMeta = JSON.parse(ctx.trialEventRows[0].client_meta_json);
  assert.strictEqual(trialMeta.response_window, 'fixation_grace');
  assert.strictEqual(trialMeta.sequence_algorithm, 'pilot2-session-sequence-v2');
  assert.strictEqual(trialMeta.sequence_seed_hash, 'a1b2c3d4');
  assert.strictEqual(trialMeta.assignment_hash, 'e5f60718');
  assert.strictEqual(trialMeta.level_sequence_hash, '11111111');
  assert.strictEqual(trialMeta.run_mode, 'qa');
  assert.strictEqual(trialMeta.schema_version, 'pilot2-event-v2');
  assert.strictEqual(trialMeta.stimulus_catalog_version, 'pilot2_balanced_targets_v2');
  assert.strictEqual(trialMeta.client_build_id, 'pilot2-normalized-data-v1');

  ctx.fullsequence = ['A.png', ctx.fixation_address, 'B.png', ctx.fixation_address, 'A.png', ctx.fixation_address];
  ctx.typesequence = [1, 0, 3, 0, 2, 0];
  assert.strictEqual(ctx.repeatLagForIndex(4), 2);

  resetSession();
  ctx.trialEventRows = Array.from({ length: 240 }, (_, index) => ({
    event_type: 'trial',
    event_id: `QA_PIPELINE-session:level:${index < 120 ? 1 : 2}:trial:${(index % 120) * 2}`,
    timestamp_iso: new Date().toISOString(),
    user_id: 'QA_PIPELINE',
    participant_id: 'QA_PIPELINE',
    session_id: 'QA_PIPELINE-session',
    study_version: 'pilot2-v1',
    level_index: index < 120 ? 1 : 2,
    trial_index: (index % 120) * 2,
    image_id: `image-${index}`,
    image_url: `https://example.test/image-${index}.png`,
    trial_type: 'filler_first',
    is_repeat: 0,
    expected_response: 0,
    participant_response: 0,
    is_correct: 1,
    rt_ms: '',
    repeat_lag: '',
    vigilance_flag: 0,
    false_alarm_flag: 0,
    hit_flag: 0,
    miss_flag: 0,
    quality_gate_status: 'ok',
    quality_gate_reason: '',
    levels_completed: 2,
    stop_after_level: '',
    pre_survey_submitted: 1,
    post_survey_submitted: 0,
    pre_q1: 'no',
    pre_q2: 'other|self:pipeline-self-description',
    pre_q3: '26-35',
    pre_q4: 'Graduate school',
    pre_q5: 'pipeline pre survey marker',
    post_q1: '', post_q2: '', post_q3: '', post_q4: '',
    post_q5: '', post_q6: '', post_q7: '', post_q8: '',
    client_meta_json: JSON.stringify({ response_window: 'none' }),
  }));
  ctx.imgstring = Array.from({ length: 480 }, (_, i) => i % 2 ? 'fixation.jpg' : `image-${i / 2}.png`).join(',');
  ctx.imtypestring = Array.from({ length: 480 }, (_, i) => i % 2 ? '0' : '3').join(',');
  ctx.perfstring = Array.from({ length: 480 }, (_, i) => i % 2 ? '0' : '14').join(',');

  const requests = [];
  ctx.fetch = async (url, options) => {
    requests.push({ url, options, payload: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        const rowCount = JSON.parse(options.body).rows.length;
        return { ok: true, received: rowCount, appended: rowCount, duplicates: 0, sheet: 'test:sheet1' };
      },
    };
  };
  const success = await ctx.sendToSheets();
  assert.strictEqual(success.ok, true);
  assert.strictEqual(success.rows, 241);
  assert.strictEqual(success.chunks, 10);
  assert.strictEqual(requests.length, 10);
  assert(requests.every(request => request.payload.rows.length <= 25));
  assert(requests.every(request => request.options.mode === 'cors'));
  assert(requests.every(request => request.options.headers['Content-Type'] === 'text/plain;charset=utf-8'));
  assert(requests.every(request => request.payload.worksheet_name === 'raw_events'));
  assert(requests.every(request => request.payload.schema_version === 'pilot2-event-v2'));
  assert.strictEqual(requests.reduce((sum, request) => sum + request.payload.rows.length, 0), 241);
  assert.strictEqual(requests[0].payload.rows[0].pre_q2, 'other|self:pipeline-self-description');
  const sentRows = requests.flatMap(request => request.payload.rows);
  const summaryRow = sentRows.find(row => row.event_type === 'session_end');
  const summaryMeta = JSON.parse(summaryRow.client_meta_json);
  assert.strictEqual(summaryMeta.sequence_algorithm, 'pilot2-session-sequence-v2');
  assert.strictEqual(summaryMeta.sequence_seed_hash, 'a1b2c3d4');
  assert.strictEqual(summaryMeta.assignment_hash, 'e5f60718');
  assert.deepStrictEqual(summaryMeta.level_sequence_hashes, { '1': '11111111', '2': '22222222' });
  assert.strictEqual(summaryMeta.run_mode, 'qa');
  assert.strictEqual(summaryMeta.schema_version, 'pilot2-event-v2');
  assert.strictEqual(summaryMeta.stimulus_catalog_version, 'pilot2_balanced_targets_v2');
  assert.strictEqual(summaryMeta.client_build_id, 'pilot2-normalized-data-v1');

  localData.clear();
  let failedRequests = 0;
  ctx.fetch = async () => {
    failedRequests++;
    throw new Error('simulated network failure');
  };
  const failure = await ctx.sendToSheets();
  assert.strictEqual(failure.ok, false);
  assert.strictEqual(failedRequests, 3);
  assert(localData.has('pilot2_checkpoint_QA_PIPELINE-session'));
  const checkpoint = JSON.parse(localData.get('pilot2_checkpoint_QA_PIPELINE-session'));
  assert.strictEqual(checkpoint.sequence_algorithm, 'pilot2-session-sequence-v2');
  assert.strictEqual(checkpoint.sequence_seed_hash, 'a1b2c3d4');
  assert.strictEqual(checkpoint.assignment_hash, 'e5f60718');
  assert.deepStrictEqual(checkpoint.level_sequence_hashes, { '1': '11111111', '2': '22222222' });
  assert.strictEqual(checkpoint.run_mode, 'qa');
  assert.strictEqual(checkpoint.schema_version, 'pilot2-event-v2');
  assert.strictEqual(checkpoint.stimulus_catalog_version, 'pilot2_balanced_targets_v2');
  assert.strictEqual(checkpoint.client_build_id, 'pilot2-normalized-data-v1');

  const experimentSource = fs.readFileSync(path.join(base, 'experiment.js'), 'utf8');
  assert(!experimentSource.includes('addEventListener("click", handlePostSubmit)'), 'submit must have one handler');

  console.log(JSON.stringify({
    status: 'PASS',
    checks: {
      levelBoundaryTokens: 4,
      devPracticeHasTwoRepeats: true,
      uniqueCrossLevelEventIds: true,
      fixationResponseMappedToImage: true,
      repeatLagCalculated: true,
      sequenceMetadataInTrials: true,
      sequenceMetadataInSummary: true,
      sequenceMetadataInCheckpoint: true,
      productionRows: success.rows,
      productionChunks: success.chunks,
      verifiedJsonAcknowledgement: true,
      failedSubmitKeepsCheckpoint: true,
      singleSubmitHandler: true,
    },
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
