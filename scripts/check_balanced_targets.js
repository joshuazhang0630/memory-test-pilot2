const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { buildWave, buildTopUp, validatePlan, planVersion, slotHeaders, makeSeededRng } =
  require('./build_target_plan');
const catalog = require('../stimulus-catalog.json');

const root = path.resolve(__dirname, '..');
const load = file => fs.readFileSync(path.join(root, file), 'utf8');
const indexByName = new Map(catalog.images.map((image, index) => [image.filename, index]));
const newCounts = () => Array.from({ length: catalog.images.length }, () => 0);

function stats(counts, threshold = 40) {
  const sorted = counts.slice().sort((a, b) => a - b);
  const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
  const sd = Math.sqrt(counts.reduce((sum, count) => sum + (count - mean) ** 2, 0) / counts.length);
  return {
    min: sorted[0],
    p05: sorted[Math.floor(sorted.length * 0.05)],
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted.at(-1),
    mean: Number(mean.toFixed(3)),
    sd: Number(sd.toFixed(3)),
    imagesWithZero: counts.filter(n => n === 0).length,
    belowThreshold: counts.filter(n => n < threshold).length,
  };
}

function mockAppsScript(plans) {
  const rows = [slotHeaders, ...plans.map(({ slotId, levels }) => [
    slotId, planVersion, catalog.version, JSON.stringify(levels), '',
  ])];
  let locked = false;
  let pending = null;
  let beforeCommit = null;
  let contentions = 0;
  let writes = 0;
  const properties = {};
  const rawRows = [];
  let rawCapacity = 1;
  let rawColumns = 26;
  const rawSheet = {
    getName: () => 'raw_events',
    getLastRow: () => rawRows.length,
    getMaxColumns: () => rawColumns,
    getMaxRows: () => rawCapacity,
    appendRow(row) { rawRows.push(row); },
    insertColumnsAfter(end, count) {
      assert.equal(end, rawColumns);
      rawColumns += count;
    },
    insertRowsAfter(end, count) {
      assert.equal(end, rawCapacity);
      rawCapacity += count;
    },
    getRange(row, col, count, width) {
      assert(locked);
      assert(row + count - 1 <= rawCapacity && col + width - 1 <= rawColumns);
      return {
        setValues(values) {
          assert.equal(col, 1);
          assert.equal(values.length, count);
          assert(values.every(value => value.length === width));
          pending = () => rawRows.push(...values);
        },
      };
    },
  };
  const sheet = {
    getLastRow: () => rows.length,
    getRange(row, col, count = 1, width = 1) {
      assert(locked, 'Slot table read outside the lock');
      return {
        getValues: () => rows.slice(row - 1, row - 1 + count)
          .map(values => values.slice(col - 1, col - 1 + width)),
        setValue(value) {
          assert.equal(col, 5);
          assert(!pending);
          pending = () => {
            rows[row - 1][col - 1] = value;
            writes++;
          };
          if (beforeCommit) {
            const concurrent = beforeCommit;
            beforeCommit = null;
            concurrent();
          }
        },
      };
    },
  };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] }) },
    LockService: {
      getScriptLock() {
        let acquired = false;
        return {
          waitLock() {
            if (locked) {
              contentions++;
              throw new Error('simulated lock timeout');
            }
            locked = true;
            acquired = true;
          },
          hasLock: () => acquired,
          releaseLock() {
            assert(!pending, 'Binding was not flushed before releasing the lock');
            locked = false;
            acquired = false;
          },
        };
      },
    },
    SpreadsheetApp: {
      openById: id => ({
        getSheetByName(name) {
          if (name === 'target_slots') return sheet;
          return name === 'raw_events' && id === 'shard-2' ? rawSheet : null;
        },
      }),
      flush() {
        assert(locked && pending);
        const commit = pending;
        pending = null;
        commit();
      },
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: json => ({ setMimeType: () => json }),
    },
  });
  vm.runInContext(load('apps-script/Code.gs'), context);
  const post = payload => JSON.parse(context.doPost({
    postData: { contents: JSON.stringify(payload) },
  }));
  const claim = participantId => post({
    action: 'claim_target_slot',
    participant_id: participantId,
    plan_version: planVersion,
    catalog_version: catalog.version,
  });
  return {
    post, claim,
    route: rows => context.balancedRawWorkbook(rows),
    properties,
    injectContention: callback => { beforeCommit = callback; },
    writes: () => writes,
    contentions: () => contentions,
    rawRows,
  };
}

function checkScorer(plans) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot2-scoring-'));
  try {
    const [hitImage, unpairedImage, failedImage] = plans[0].levels[0];
    const track = filename => filename.slice(0, -4);
    const row = (slot, session, filename, role, response, opts = {}) => ({
      event_type: 'trial',
      timestamp_iso: '2026-11-01T00:00:0' + (opts.time || 1) + 'Z',
      participant_id: opts.participant || 'synthetic',
      session_id: session,
      study_version: opts.study || planVersion,
      level_index: '1',
      image_id: track(filename),
      trial_type: role,
      participant_response: response,
      quality_gate_status: opts.failed ? 'failed' : 'ok',
      client_meta_json: JSON.stringify({
        run_mode: 'production', slot_id: slot, plan_version: planVersion,
        stimulus_catalog_version: catalog.version,
      }),
    });
    const examples = [
      row('S1', 'primary', hitImage, 'target_first', 0),
      row('S1', 'primary', hitImage, 'target_repeat', 1),
      row('S1', 'primary', unpairedImage, 'target_first', 1),
      row('S1', 'retake', unpairedImage, 'target_first', 0, { time: 2 }),
      row('S1', 'retake', unpairedImage, 'target_repeat', 1, { time: 2 }),
      row('S2', 'failed', failedImage, 'target_first', 0),
      row('S2', 'failed', failedImage, 'target_repeat', 1),
      row('S2', 'failed', failedImage, 'vigilance_repeat', 0, { failed: true }),
      row('S3', 'legacy', unpairedImage, 'target_repeat', 1, { study: 'pilot2-shared-targets-v1' }),
      row('S4', 'qa', unpairedImage, 'target_repeat', 1, { participant: 'QA_SCORE' }),
    ];
    const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
    const raw = path.join(directory, 'raw_events.csv');
    const coverage = path.join(directory, 'coverage.json');
    const scores = path.join(directory, 'scores.csv');
    fs.writeFileSync(raw, Object.keys(examples[0]).join(',') + '\n' +
      examples.map(example => Object.values(example).map(quote).join(',')).join('\n') + '\n');
    execFileSync('python3', [path.join(root, 'scripts/summarize_balanced_results.py'), raw, raw,
      '--coverage', coverage, '--scores', scores]);
    const data = JSON.parse(fs.readFileSync(coverage, 'utf8'));
    assert.deepEqual(data.pairs_by_level[hitImage], [1, 0, 0, 0, 0]);
    assert.deepEqual(data.pairs_by_level[unpairedImage], [0, 0, 0, 0, 0]);
    assert.deepEqual(data.pairs_by_level[failedImage], [0, 0, 0, 0, 0]);
    const scored = fs.readFileSync(scores, 'utf8').split('\n').find(line => line.startsWith(hitImage + ','));
    assert(scored, 'Score row is missing');
    const fields = scored.split(',');
    assert.equal(fields[2], '1');
    assert.equal(fields[4], '0');
    assert(Number(fields.at(-1)) > 0, 'Corrected d-prime must be finite at a raw boundary');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function compareHits(plannedCounts, independentCounts) {
  const p = 0.55;
  const repetitions = 500;
  const spread = [0, 0];
  let example;
  for (let i = 0; i < repetitions; i++) {
    const rng = makeSeededRng(20261125 + i);
    const simulated = [plannedCounts, independentCounts].map(counts => stats(counts.map(count => {
      let hits = 0;
      for (let j = 0; j < count; j++) {
        if (rng() < p) hits++;
      }
      return hits;
    }), 0));
    if (i === 0) example = { balanced: simulated[0], independent: simulated[1] };
    simulated.forEach((result, index) => { spread[index] += result.sd; });
  }
  const [balanced, independent] = spread.map(total => Number((total / repetitions).toFixed(3)));
  assert(balanced < independent);
  return { p, repetitions, meanBetweenImageHitCountSd: { balanced, independent }, example };
}

async function main() {
  const seed = 'pilot2-target-plan-v1';
  const plans = Array.from({ length: 4 }, (_, n) => buildWave(n + 1, seed)).flat();
  validatePlan(plans, true);
  assert.deepEqual(buildWave(1, seed), plans.slice(0, 225));
  assert.notDeepEqual(buildWave(1, 'another seed'), plans.slice(0, 225));
  const backend = mockAppsScript(plans);
  backend.injectContention(() => assert.equal(backend.claim('participant-2').ok, false));
  assert.equal(backend.claim('participant-1').slot_id, plans[0].slotId);
  assert.equal(backend.contentions(), 1);
  assert.equal(backend.claim('participant-1').slot_id, plans[0].slotId);
  assert.equal(backend.writes(), 1);
  assert.equal(backend.claim('QA_TEST').ok, false);
  assert.equal(backend.post({ worksheet_name: 'target_slots' }).code, 'reserved_worksheet');
  backend.properties.PILOT2_RAW_WORKBOOKS = JSON.stringify({ W01: 'shard-1', W02: 'shard-2' });
  const balancedRow = {
    study_version: planVersion, session_id: 's1', client_meta_json: '{"slot_id":"W02-001"}',
  };
  assert.equal(backend.route([balancedRow]), 'shard-2');
  assert.throws(() => backend.route([balancedRow, { ...balancedRow, session_id: 's2' }]),
    /inconsistent session slot/);
  assert.throws(() => backend.route([{ ...balancedRow, client_meta_json: '{"slot_id":"W03-001"}' }]),
    /Missing raw_events workbook/);
  assert.equal(backend.route([{ ...balancedRow, study_version: 'legacy' }]), '');
  const rawAck = backend.post({ rows: [{ ...balancedRow, event_id: 's1:trial:0', event_type: 'trial' }] });
  assert.equal(rawAck.ok, true, JSON.stringify(rawAck));
  assert.equal(rawAck.sheet, 'shard-2:raw_events');
  assert.equal(rawAck.appended, 1);
  assert.equal(backend.rawRows.length, 2);

  const elements = new Map();
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, AbortController,
    document: {
      body: { innerHTML: '' },
      addEventListener() {},
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {});
        return elements.get(id);
      },
    },
    fetch: async (url, options) => ({
      ok: true,
      json: async () => url === './stimulus-catalog.json' ? catalog : backend.post(JSON.parse(options.body)),
    }),
  });
  context.window = context;
  for (const file of ['state.js', 'utils.js', 'data.js', 'survey.js', 'experiment.js']) {
    vm.runInContext(load(file), context, { filename: file });
  }
  context.renderShell = html => html;
  context.prepareBlockImages = async sequence => {
    assert(sequence.length > 17);
    return true;
  };
  await context.requireImagesReady();
  assert.throws(() => context.initializeParticipantLevels('unassigned', 'session'), /target_slot_required/);
  const plannedCounts = newCounts();
  const independentCounts = newCounts();
  const levelCounts = Object.fromEntries(catalog.images.map(image => [image.filename, [0, 0, 0, 0, 0]]));
  const prefixCounts = {};
  const attrition = makeSeededRng(41617);
  for (const [index, plan] of plans.entries()) {
    const pid = 'participant-' + (index + 1);
    const sessionId = pid + '-session';
    context.activeTargetSlot = null;
    context.pid = pid;
    if (index === 0) {
      await context.startPretrain();
      assert.equal(context.pretrainImages.length, 17);
      assert(context.pretrainImages.every(url => !context.activeTargetSlot.levels.flat().includes(url)));
    } else {
      await context.reserveTargetSlot(pid);
    }
    assert.equal(context.targetSlotMetadata().slot_id, plan.slotId);
    assert.equal(context.targetSlotMetadata().plan_version, planVersion);
    const practice = context.practiceImagesForSession(pid, sessionId);
    const seen = new Set(practice);
    assert.equal(seen.size, 17);
    const levels = context.initializeParticipantLevels(pid, sessionId);
    const validLevels = attrition() < 0.05 ? 0 : attrition() < 0.10 ? Math.floor(attrition() * 5) : 5;
    for (const [l, names] of plan.levels.entries()) {
      const level = levels[String(l + 1)];
      const expected = names.map(name => catalog.baseUrl + encodeURIComponent(name));
      assert.deepEqual(Array.from(level.targets), expected);
      assert.equal(level.fillers.length, 82);
      assert.equal(level.vigilance.length, 6);
      for (const url of level.targets.concat(level.fillers)) {
        assert(!seen.has(url));
        seen.add(url);
      }
      const built = context.buildLevelSequence(String(l + 1));
      assert.equal(built.sequence.length, 120);
      assert.equal(built.types.filter(type => type === 2).length, 16);
      assert.equal(built.types.filter(type => type === 4).length, 6);
      for (const [urls, min, max] of [[level.targets, 91, 109], [level.vigilance, 1, 7]]) {
        for (const url of urls) {
          const lag = built.sequence.lastIndexOf(url) - built.sequence.indexOf(url);
          assert(lag >= min && lag <= max);
        }
      }
      for (const name of names) {
        plannedCounts[indexByName.get(name)]++;
        if (l < validLevels) levelCounts[name][l]++;
      }
    }
    assert.equal(seen.size, 507);
    if ([15, 23, 30, 45, 225, 900].includes(index + 1)) {
      prefixCounts[index + 1] = stats(plannedCounts, 1);
    }
    const baseline = context.initializeParticipantLevels('QA_BASELINE', 'baseline-' + index);
    for (const level of Object.values(baseline)) {
      for (const url of level.targets) {
        independentCounts[indexByName.get(decodeURIComponent(url.split('/').pop()))]++;
      }
    }
  }
  assert.equal(backend.writes(), plans.length);
  assert.equal(backend.claim('new-participant').code, 'target_slots_full');
  assert.equal(backend.claim('participant-1').slot_id, plans[0].slotId);
  context.pretrainSequence = [];
  context.pid = 'new-participant';
  await context.startPretrain();
  assert.match(elements.get('practice-start-status').textContent, /allocated/);
  assert(plannedCounts.every(n => n === 40));
  const balancedLevels = new Map(catalog.images.map(image => [image.filename, [0, 0, 0, 0, 0]]));
  plans.forEach(plan => plan.levels.forEach((level, l) =>
    level.forEach(name => { balancedLevels.get(name)[l]++; })));
  assert([...balancedLevels.values()].every(levels => levels.every(n => n === 8)));

  const totals = () => Object.values(levelCounts).map(levels => levels.reduce((a, b) => a + b, 0));
  const beforeTopUp = stats(totals());
  const topUp = buildTopUp(1, 135, seed, {
    study_version: planVersion, catalog_version: catalog.version, pairs_by_level: levelCounts,
  });
  validatePlan(topUp, false);
  const afterTopUp = {};
  topUp.forEach((plan, index) => {
    plan.levels.forEach((level, l) => level.forEach(name => { levelCounts[name][l]++; }));
    if ((index + 1) % 45 === 0) afterTopUp[index + 1] = stats(totals());
  });
  assert(afterTopUp[45].sd < beforeTopUp.sd);
  assert(afterTopUp[135].belowThreshold < afterTopUp[45].belowThreshold);
  checkScorer(plans);

  console.log(JSON.stringify({
    status: 'PASS',
    testedSlots: plans.length,
    testedLevelSequences: plans.length * 5,
    mockBackend: 'practice entry, retry, lock contention, exhaustion, workbook routing and raw log growth',
    prefixCounts,
    completeRuns: { balanced: stats(plannedCounts), independent: stats(independentCounts) },
    simulatedHits: compareHits(plannedCounts, independentCounts),
    attritionAndTopUp: {
      assumptions: '5% quality exclusion, 10% early exit among the rest; all top-up slots completed',
      beforeTopUp, afterTopUp,
    },
    scorer: 'paired target rows, raw file overlap, duplicate session, failure, legacy and QA exclusion',
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
