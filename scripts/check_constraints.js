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
ctx.fetch = fetch;
vm.createContext(ctx);

function load(file) {
  return fs.readFileSync(path.join(base, file), 'utf8');
}

vm.runInContext(load('state.js'), ctx);
vm.runInContext(load('utils.js'), ctx);
vm.runInContext(load('data.js'), ctx);
vm.runInContext(load('experiment.js'), ctx);

if (process.env.PILOT2_TARGET_MANIFEST_URL) {
  ctx.targetManifestUrl = process.env.PILOT2_TARGET_MANIFEST_URL;
}
if (process.env.PILOT2_FILLER_MANIFEST_URL) {
  ctx.fillerManifestUrl = process.env.PILOT2_FILLER_MANIFEST_URL;
}

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

function setEquals(actual, expected) {
  if (actual.size !== expected.size) return false;
  for (const value of actual) {
    if (!expected.has(value)) return false;
  }
  return true;
}

(async () => {
  await ctx.ensureImagesLoaded();
  const registry = ctx.manifestData.registry;
  const targetCatalog = new Set(registry.targets.map(record => record.url));
  const fillerCatalog = new Set(registry.fillers.map(record => record.url));
  const targetLevelObservations = new Map([...targetCatalog].map(url => [url, new Set()]));
  const fillerLevelObservations = new Map([...fillerCatalog].map(url => [url, new Set()]));
  const targetPositionObservations = new Map([...targetCatalog].map(url => [url, new Set()]));
  const sessionHashes = new Set();

  const summary = {
    sessions: SESSION_COUNT,
    algorithm: ctx.sequenceAlgorithm,
    targetCatalogSize: targetCatalog.size,
    fillerCatalogSize: fillerCatalog.size,
    uniqueSessionSequenceHashes: 0,
    duplicateSessionSequenceHashes: 0,
    sameSessionReproductionMismatches: 0,
    targetLevelVariationViolations: 0,
    fillerLevelVariationViolations: 0,
    targetPositionVariationViolations: 0,
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
    const seenAcrossLevels = new Set();
    const assignedTargets = new Set();
    const assignedFillers = new Set();
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
        if (!targetCatalog.has(url)) summary.catalogCoverageViolations += 1;
        if (seenAcrossLevels.has(url)) summary.overlapViolations += 1;
        seenAcrossLevels.add(url);
        assignedTargets.add(url);
        if (recordObservations) targetLevelObservations.get(url).add(levelKey);
      }
      for (const url of fillerSet) {
        if (!fillerCatalog.has(url)) summary.catalogCoverageViolations += 1;
        if (seenAcrossLevels.has(url)) summary.overlapViolations += 1;
        seenAcrossLevels.add(url);
        assignedFillers.add(url);
        if (recordObservations) fillerLevelObservations.get(url).add(levelKey);
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

      if (recordObservations) {
        built.types.forEach((type, index) => {
          if (type === TARGET) {
            targetPositionObservations.get(built.sequence[index]).add(`${levelKey}:${index}`);
          }
        });
      }

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

    if (!setEquals(assignedTargets, targetCatalog) || !setEquals(assignedFillers, fillerCatalog)) {
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
  summary.targetLevelVariationViolations = [...targetLevelObservations.values()].filter(set => set.size < 2).length;
  summary.fillerLevelVariationViolations = [...fillerLevelObservations.values()].filter(set => set.size < 2).length;
  summary.targetPositionVariationViolations = [...targetPositionObservations.values()].filter(set => set.size < 2).length;

  const zeroFields = [
    'duplicateSessionSequenceHashes',
    'sameSessionReproductionMismatches',
    'targetLevelVariationViolations',
    'fillerLevelVariationViolations',
    'targetPositionVariationViolations',
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

  fs.writeFileSync(path.join(base, 'reports/step3_constraints.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.allChecksPassed) process.exitCode = 1;
})();
