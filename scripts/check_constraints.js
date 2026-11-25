const fs = require('fs');
const path = require('path');
const vm = require('vm');

const base = path.resolve(__dirname, '..');
const quietConsole = { log() {}, warn() {}, error() {} };
const ctx = { console: quietConsole, setTimeout, clearTimeout };
ctx.document = {
  onkeydown: null,
  addEventListener() {},
  getElementById: () => ({ value: '', innerHTML: '', src: '', style: {}, setAttribute() {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { innerHTML: '' },
};
ctx.window = ctx;
ctx.fetch = async url => {
  if (url !== './stimulus-catalog.json') throw new Error('Unexpected catalog URL: ' + url);
  return { ok: true, json: async () => JSON.parse(load('stimulus-catalog.json')) };
};
vm.createContext(ctx);

function load(file) {
  return fs.readFileSync(path.join(base, file), 'utf8');
}

vm.runInContext(load('state.js'), ctx);
vm.runInContext(load('utils.js'), ctx);
vm.runInContext(load('data.js'), ctx);
vm.runInContext(load('experiment.js'), ctx);

const TARGET = 1;
const REPEAT = 2;
const FILLER = 3;
const VIGILANCE = 4;
const SESSION_COUNT = 200;

function calcLags(sequence, types) {
  const out = { target: [], vigilance: [] };
  const firstSeen = new Map();
  for (let index = 0; index < sequence.length; index += 1) {
    const imageId = (sequence[index] || '').split('/').pop();
    const type = types[index];
    if (type === TARGET || type === FILLER) {
      if (!firstSeen.has(imageId)) firstSeen.set(imageId, index);
    } else if (type === REPEAT) {
      const first = firstSeen.get(imageId);
      if (first !== undefined) out.target.push(index - first);
    } else if (type === VIGILANCE) {
      const first = firstSeen.get(imageId);
      if (first !== undefined) out.vigilance.push(index - first);
    }
  }
  return out;
}

(async () => {
  await ctx.requireImagesReady();
  const catalog = ctx.manifestData.catalog;
  const catalogUrls = new Set(catalog.map(record => record.url));
  const strataByUrl = new Map(catalog.map(record => [record.url, record.stratum]));
  const allTargets = new Set();
  const allFillers = new Set();
  const sessionHashes = new Set();

  const summary = {
    sessions: SESSION_COUNT,
    algorithm: ctx.sequenceAlgorithm,
    catalogSize: catalogUrls.size,
    uniqueSessionSequenceHashes: 0,
    duplicateSessionSequenceHashes: 0,
    sameSessionReproductionMismatches: 0,
    stratificationViolations: 0,
    catalogCoverageViolations: 0,
    roleCountViolations: 0,
    overlapViolations: 0,
    targetLagViolations: 0,
    vigilanceLagViolations: 0,
    nullSlotViolations: 0,
    sequenceBuildErrors: 0,
    samples: [],
  };

  function buildSession(participantId, sessionId, recordObservations) {
    ctx.initializeParticipantLevels(participantId, sessionId);
    const levels = ctx.manifestData.levels;
    const levelKeys = Object.keys(levels).sort();
    if (levelKeys.length !== 5 || levelKeys.join(',') !== '1,2,3,4,5') {
      summary.roleCountViolations += 1;
    }
    const practice = ctx.practiceImagesForSession(participantId, sessionId);
    const seenAcrossLevels = new Set(practice);
    if (seenAcrossLevels.size !== 17 || !practice.every(url => catalogUrls.has(url))) {
      summary.catalogCoverageViolations += 1;
    }
    const remaining = new Map();
    for (const {url, stratum} of catalog) {
      if (!seenAcrossLevels.has(url)) remaining.set(stratum, (remaining.get(stratum) || 0) + 1);
    }
    let remainingCount = catalog.length - practice.length;
    function checkStratification(urls) {
      const observed = new Map();
      for (const url of urls) {
        const stratum = strataByUrl.get(url);
        observed.set(stratum, (observed.get(stratum) || 0) + 1);
      }
      for (const [stratum, available] of remaining) {
        const expected = available * urls.length / remainingCount;
        const actual = observed.get(stratum) || 0;
        if (actual < Math.floor(expected) || actual > Math.ceil(expected)) {
          summary.stratificationViolations += 1;
        }
        remaining.set(stratum, available - actual);
      }
      remainingCount -= urls.length;
    }
    for (const key of levelKeys) checkStratification(levels[key].targets);
    for (const key of levelKeys) {
      const { vigilance, fillers } = levels[key];
      checkStratification(vigilance);
      checkStratification(fillers.filter(url => !vigilance.includes(url)));
    }
    const fingerprintParts = [ctx.sequenceContext.seedHash, ctx.sequenceContext.assignmentHash];
    const sample = {
      sessionId,
      seedHash: ctx.sequenceContext.seedHash,
      assignmentHash: ctx.sequenceContext.assignmentHash,
      levels: {},
    };

    for (const levelKey of levelKeys) {
      const level = levels[levelKey];
      const targetSet = new Set(level.targets);
      const fillerSet = new Set(level.fillers);
      const vigilanceSet = new Set(level.vigilance);
      if (
        targetSet.size !== 16 ||
        fillerSet.size !== 82 ||
        vigilanceSet.size !== 6 ||
        ![...vigilanceSet].every(url => fillerSet.has(url))
      ) {
        summary.roleCountViolations += 1;
      }

      for (const url of targetSet) {
        if (!catalogUrls.has(url)) summary.catalogCoverageViolations += 1;
        if (seenAcrossLevels.has(url)) summary.overlapViolations += 1;
        seenAcrossLevels.add(url);
        if (recordObservations) allTargets.add(url);
      }
      for (const url of fillerSet) {
        if (!catalogUrls.has(url)) summary.catalogCoverageViolations += 1;
        if (seenAcrossLevels.has(url)) summary.overlapViolations += 1;
        seenAcrossLevels.add(url);
        if (recordObservations) allFillers.add(url);
      }

      const built = ctx.buildLevelSequence(levelKey);
      if (built.sequence.length !== 120 || built.sequence.some(value => !value)) {
        summary.nullSlotViolations += 1;
      }

      const targetPresentations = built.types.filter(type => type === TARGET || type === REPEAT).length;
      const vigilancePresentations = built.sequence.filter(url => vigilanceSet.has(url)).length;
      const fillerSinglePresentations = built.sequence.filter(
        url => !targetSet.has(url) && !vigilanceSet.has(url),
      ).length;
      if (targetPresentations !== 32 || vigilancePresentations !== 12 || fillerSinglePresentations !== 76) {
        summary.roleCountViolations += 1;
      }

      const lags = calcLags(built.sequence, built.types);
      summary.targetLagViolations += lags.target.filter(
        lag => lag < ctx.targetRepeatDelayMin || lag > ctx.targetRepeatDelayMax,
      ).length;
      summary.vigilanceLagViolations += lags.vigilance.filter(
        lag => lag < 1 || lag > ctx.vigilanceRepeatMaxGap,
      ).length;

      fingerprintParts.push(
        levelKey,
        level.targets.join(','),
        level.vigilance.join(','),
        level.fillers.join(','),
        built.sequence.join(','),
        built.types.join(','),
      );
      sample.levels[levelKey] = {
        sequenceHash: built.sequenceHash,
        targetLagMin: Math.min(...lags.target),
        targetLagMax: Math.max(...lags.target),
        vigilanceLagMin: Math.min(...lags.vigilance),
        vigilanceLagMax: Math.max(...lags.vigilance),
      };
    }

    if (seenAcrossLevels.size !== 17 + 5 * 98) {
      summary.catalogCoverageViolations += 1;
    }
    sample.sessionSequenceHash = ctx.hashHex(fingerprintParts.join('||'));
    return { fingerprint: fingerprintParts.join('||'), hash: sample.sessionSequenceHash, sample };
  }

  const participantId = 'synthetic-login-user';
  for (let index = 0; index < SESSION_COUNT; index += 1) {
    const sessionId = `${participantId}-login-${String(index + 1).padStart(3, '0')}`;
    try {
      const first = buildSession(participantId, sessionId, true);
      const replay = buildSession(participantId, sessionId, false);
      if (first.fingerprint !== replay.fingerprint) {
        summary.sameSessionReproductionMismatches += 1;
      }
      if (sessionHashes.has(first.hash)) {
        summary.duplicateSessionSequenceHashes += 1;
      }
      sessionHashes.add(first.hash);
      if (summary.samples.length < 5) summary.samples.push(first.sample);
    } catch (error) {
      summary.sequenceBuildErrors += 1;
      if (summary.samples.length < 5) {
        summary.samples.push({ sessionId, error: String(error && error.message ? error.message : error) });
      }
    }
  }

  summary.uniqueSessionSequenceHashes = sessionHashes.size;
  summary.imagesSampledAsTargets = allTargets.size;
  summary.imagesSampledAsFillers = allFillers.size;
  summary.imagesSampledInBothRoles = [...allTargets].filter(url => allFillers.has(url)).length;

  const zeroFields = [
    'duplicateSessionSequenceHashes',
    'sameSessionReproductionMismatches',
    'stratificationViolations',
    'catalogCoverageViolations',
    'roleCountViolations',
    'overlapViolations',
    'targetLagViolations',
    'vigilanceLagViolations',
    'nullSlotViolations',
    'sequenceBuildErrors',
  ];
  summary.allChecksPassed =
    summary.uniqueSessionSequenceHashes === SESSION_COUNT &&
    zeroFields.every(field => summary[field] === 0);

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.allChecksPassed) process.exitCode = 1;
})();
