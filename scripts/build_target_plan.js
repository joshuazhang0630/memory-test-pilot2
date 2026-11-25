const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseArgs } = require('node:util');

const repo = path.resolve(__dirname, '..');
const catalog = require('../stimulus-catalog.json');
const planVersion = 'pilot2-balanced-slots-v1';
const slotHeaders = ['slot_id', 'plan_version', 'catalog_version', 'targets_json', 'participant_key'];
const { hashString, makeSeededRng, shuffleWithRng, makeStratifiedSampler } = vm.runInNewContext(
  fs.readFileSync(path.join(repo, 'data.js'), 'utf8') +
    '\n({hashString, makeSeededRng, shuffleWithRng, makeStratifiedSampler})'
);

const levelCount = 5;
const targetsPerLevel = 16;
const slotsPerBlock = 45;
const halfBlock = 22;
const filenames = new Set(catalog.images.map(image => image.filename));
const byStratum = Map.groupBy(catalog.images, image => image.stratum);

function buildWave(wave, seed) {
  const rng = makeSeededRng(hashString(seed + '|wave|' + wave));
  const shuffle = items => shuffleWithRng(Array.from(items), rng);
  const groups = Array.from({ length: levelCount }, () => []);
  let index = 0;
  for (const stratum of shuffle(byStratum.values())) {
    for (const image of shuffle(stratum)) {
      groups[index++ % levelCount].push(image);
    }
  }
  assert.equal(filenames.size, 1800);
  assert(groups.every(group => group.length === 360));

  const rows = [];
  for (let block = 0; block < levelCount; block++) {
    const slots = Array.from({ length: slotsPerBlock }, () => []);
    for (let level = 0; level < levelCount; level++) {
      const group = groups[(level + block) % levelCount];
      const strata = shuffle(Map.groupBy(group, image => image.stratum).values());
      const first = [];
      const second = [];
      for (const stratum of strata) {
        first.push(...shuffle(stratum));
        second.push(...shuffle(stratum));
      }

      // Each pass covers the full group. Pair pockets separated by 22 seats
      // to round the chart-type quotas proportionally. Slot 23 joins the
      // eight unused cards from each pass.
      const firstSeam = slotsPerBlock - 1;
      const secondSeam = (firstSeam + halfBlock) % slotsPerBlock;
      for (let i = secondSeam; i < second.length; i += slotsPerBlock) {
        if (!first.some((image, j) => j % slotsPerBlock === firstSeam && image === second[i])) {
          continue;
        }
        const swap = second.findIndex((image, j) =>
          image.stratum === second[i].stratum && j % slotsPerBlock !== secondSeam);
        assert(swap >= 0, 'Cannot resolve a duplicate at the pass boundary');
        [second[i], second[swap]] = [second[swap], second[i]];
      }
      const pocket = (deck, seat) => deck.filter((_, i) => i % slotsPerBlock === seat);
      for (let i = 0; i < halfBlock; i++) {
        slots[i].push(pocket(first, i).concat(pocket(first, i + halfBlock)));
        const seat = (secondSeam + 1 + i) % slotsPerBlock;
        slots[halfBlock + 1 + i].push(pocket(second, seat)
          .concat(pocket(second, (seat + halfBlock) % slotsPerBlock)));
      }
      slots[halfBlock].push(pocket(first, firstSeam).concat(pocket(second, secondSeam)));
    }
    const ordered = shuffle(slots.slice(0, halfBlock)).concat(
      [slots[halfBlock]], shuffle(slots.slice(halfBlock + 1))
    );
    ordered.forEach((levels, i) => {
      const slotId = 'W' + String(wave).padStart(2, '0') + '-' +
        String(block * slotsPerBlock + i + 1).padStart(3, '0');
      rows.push({ slotId, levels: levels.map(level => level.map(image => image.filename)) });
    });
  }
  return rows;
}

function buildTopUp(batch, size, seed, coverage) {
  assert.equal(coverage.study_version, planVersion, 'Coverage must use the current study version');
  assert.equal(coverage.catalog_version, catalog.version, 'Coverage catalog version mismatch');
  const rng = makeSeededRng(hashString(seed + '|top-up|' + batch));
  const cards = catalog.images.map(image => {
    const levels = coverage.pairs_by_level[image.filename];
    assert(Array.isArray(levels) && levels.length === levelCount &&
      levels.every(n => Number.isSafeInteger(n) && n >= 0), 'Invalid coverage for ' + image.filename);
    return { ...image, url: image.filename, levels: levels.slice(), total: levels.reduce((a, b) => a + b, 0) };
  });
  const strataByName = new Map(cards.map(card => [card.filename, card.stratum]));
  // Recreate the sampler per level so quotas reflect the full catalog.
  const sampleQuotas = () => Map.groupBy(
    makeStratifiedSampler(cards, rng)(targetsPerLevel), filename => strataByName.get(filename));
  return Array.from({ length: size }, (_, slotIndex) => {
    const available = Map.groupBy(shuffleWithRng(cards, rng), card => card.stratum);
    const levels = Array.from({ length: levelCount }, () => []);
    const levelOrder = shuffleWithRng([0, 1, 2, 3, 4], rng);
    for (const level of levelOrder) {
      for (const [stratum, quota] of sampleQuotas()) {
        const bucket = available.get(stratum);
        bucket.sort((a, b) => a.total - b.total || a.levels[level] - b.levels[level]);
        const chosen = bucket.splice(0, quota.length);
        levels[level].push(...chosen);
      }
      // Singleton strata can run out across five levels. Fill any shortfall
      // from the least-observed cards that are still available for this slot.
      if (levels[level].length < targetsPerLevel) {
        const remaining = shuffleWithRng(Array.from(available.values()).flat(), rng);
        remaining.sort((a, b) => a.total - b.total || a.levels[level] - b.levels[level]);
        for (const card of remaining.slice(0, targetsPerLevel - levels[level].length)) {
          const bucket = available.get(card.stratum);
          bucket.splice(bucket.indexOf(card), 1);
          levels[level].push(card);
        }
      }
      for (const card of levels[level]) {
        card.total++;
        card.levels[level]++;
      }
    }
    return {
      slotId: 'T' + String(batch).padStart(2, '0') + '-' + String(slotIndex + 1).padStart(3, '0'),
      levels: levels.map(level => level.map(card => card.filename)),
    };
  });
}

function validatePlan(rows, balanced) {
  const slots = new Set();
  const counts = new Map(catalog.images.map(image => [image.filename, 0]));
  const strataByName = new Map(catalog.images.map(image => [image.filename, image.stratum]));
  for (const [index, { slotId, levels }] of rows.entries()) {
    const targets = levels.flat();
    assert(!slots.has(slotId), 'Duplicate slot: ' + slotId);
    slots.add(slotId);
    assert(levels.length === levelCount && levels.every(level => level.length === targetsPerLevel));
    assert(new Set(targets).size === levelCount * targetsPerLevel);
    for (const filename of targets) {
      assert(filenames.has(filename), 'Unknown image: ' + filename);
      counts.set(filename, counts.get(filename) + 1);
    }
    if (balanced) {
      const mean = (index + 1) * levelCount * targetsPerLevel / filenames.size;
      for (const count of counts.values()) {
        assert(count >= Math.floor(mean) && count <= Math.ceil(mean), 'Unbalanced slot prefix');
      }
      for (const level of levels) {
        const assigned = Map.groupBy(level, filename => strataByName.get(filename));
        for (const [stratum, group] of byStratum) {
          const quota = targetsPerLevel * group.length / filenames.size;
          const actual = assigned.get(stratum)?.length ?? 0;
          assert(actual >= Math.floor(quota) && actual <= Math.ceil(quota), 'Unbalanced chart-type quota');
        }
      }
    }
  }
}

function toCsv(rows) {
  const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
  return slotHeaders.join(',') + '\n' + rows.map(({ slotId, levels }) =>
    [slotId, planVersion, catalog.version, JSON.stringify(levels), ''].map(quote).join(',')
  ).join('\n') + '\n';
}

function main() {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      start: { type: 'string', default: '1' },
      waves: { type: 'string', default: '1' },
      seed: { type: 'string', default: 'pilot2-target-plan-v1' },
      coverage: { type: 'string' },
      slots: { type: 'string', default: '45' },
    },
  });
  assert(values.output, 'Provide --output target_slots.csv');
  const start = Number(values.start);
  const size = Number(values.coverage ? values.slots : values.waves);
  assert(Number.isSafeInteger(start) && start > 0 && Number.isSafeInteger(size) && size > 0);
  const rows = values.coverage
    ? buildTopUp(start, size, values.seed, JSON.parse(fs.readFileSync(values.coverage, 'utf8')))
    : Array.from({ length: size }, (_, i) => buildWave(start + i, values.seed)).flat();
  validatePlan(rows, !values.coverage);
  fs.writeFileSync(values.output, toCsv(rows), { flag: 'wx' });
  console.log('Wrote ' + rows.length + ' slots to ' + values.output);
}

module.exports = { buildWave, buildTopUp, validatePlan, toCsv, planVersion, slotHeaders, makeSeededRng };
if (require.main === module) main();
