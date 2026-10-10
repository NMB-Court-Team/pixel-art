const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chooseQuotaPath } = require('../js/import-optimizer.js');

function fixture(values, colors, minPixels, options = {}) {
  const palette = colors.map((color, c) => ({ id: String(c), color }));
  const pixels = values.map(value => value === null ? null : String(colors.reduce((best, color, c) =>
    Math.abs(value - color) < Math.abs(value - colors[best]) ? c : best, 0)));
  return { palette, pixels, samples: values.flatMap((lab, i) => lab === null ? [] : [{ i, lab, weight: 1 }]),
    width: values.length, minPixels, distance: (a, b) => Math.abs(a - b), colorLab: color => color,
    locality: 1, ...options };
}
function validate(result, minimum, original) {
  for (const entry of result.palette) assert.ok(result.pixels.filter(id => id === entry.id).length >= minimum);
  original.forEach((id, i) => assert.equal(result.pixels[i] === null, id === null));
  assert.ok(result.pixels.every(id => id === null || result.palette.some(entry => entry.id === id)));
}

test('grows a rare color when a nearby ambiguous cell costs less than merging', () => {
  const options = fixture([0, 0, 0, 0, 0, 0, 4.9, 4.9, 10, 10], [0, 10], 3);
  const result = chooseQuotaPath(options);
  validate(result, 3, options.pixels);
  assert.equal(result.palette.length, 2);
  assert.equal(result.expandedColors, 1);
  assert.equal(result.reassignedPixels, 1);
  assert.equal(result.pathStats.optimal, true);
});

test('merges a rare color even with enough total capacity when growth is more costly', () => {
  const options = fixture([0, 0, 0, 0, 0, 0, 0, 0, 0, 10], [0, 10], 5);
  const result = chooseQuotaPath(options);
  validate(result, 5, options.pixels);
  assert.equal(result.mergedCount, 1);
  assert.equal(result.expandedColors, 0);
  assert.equal(result.reassignedPixels, 1);
  assert.equal(result.pathStats.comparedPlans, 2);
});

test('can grow one color and merge another in the same jointly evaluated plan', () => {
  const options = fixture([0, 0, 0, 0, 0, 0, 4.9, 10, 10, 10, 0, 0, 0, 0, 0, 0, 30], [0, 10, 30], 4);
  const result = chooseQuotaPath(options);
  validate(result, 4, options.pixels);
  assert.equal(result.mergedCount, 1);
  assert.equal(result.expandedColors, 1);
  assert.deepEqual(result.palette.map(entry => entry.color), [0, 10]);
  assert.equal(result.pathStats.optimal, true);
});

test('joint decisions match exhaustive assignment on small palettes', () => {
  let seed = 73;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 40; trial++) {
    const options = fixture([0, 5, 10, ...Array.from({ length: 4 }, () => random() * 10)], [0, 5, 10], 3, { locality: 0 });
    const originalCounts = options.palette.map(entry => options.pixels.filter(id => id === entry.id).length);
    let best = Infinity;
    const visit = (p, counts, cost) => {
      if (cost > best) return;
      if (p === options.samples.length) {
        if (counts.some((count, c) => count > 0 && count < 3 || originalCounts[c] >= 3 && count === 0)) return;
        best = cost; return;
      }
      for (let c = 0; c < 3; c++) {
        counts[c]++; visit(p + 1, counts, cost + (options.samples[p].lab - options.palette[c].color) ** 2); counts[c]--;
      }
    };
    visit(0, [0, 0, 0], 0);
    const result = chooseQuotaPath(options);
    validate(result, 3, options.pixels);
    assert.ok(Math.abs(result.pathStats.cost - best) < 1e-7);
    assert.equal(result.pathStats.optimal, true);
  }
});

test('all-rare colors and insufficient capacity still produce a feasible plan', () => {
  const options = fixture([0, 0, 10, null, 10, 20, 20], [0, 10, 20], 3);
  const result = chooseQuotaPath(options);
  validate(result, 3, options.pixels);
  assert.ok(result.palette.length <= 2);
  assert.equal(result.feasible, true);
  assert.deepEqual(result, chooseQuotaPath(options));
});

test('impossible quota is reported, valid imports and empty images remain unchanged', () => {
  const sparse = chooseQuotaPath(fixture([0, null, 10], [0, 10], 3));
  assert.equal(sparse.feasible, false);
  assert.equal(sparse.palette.length, 1);
  assert.equal(sparse.pixels[1], null);
  assert.equal(sparse.visiblePixels, 2);
  for (const options of [fixture([0, 0, null, 10, 10], [0, 10], 2), fixture([null, null], [0, 10], 2)]) {
    const result = chooseQuotaPath(options);
    assert.deepEqual(result.pixels, options.pixels);
    assert.equal(result.reassignedPixels, 0);
  }
});

test('bounded search always returns its complete incumbent and reports the search limit', () => {
  const options = fixture([0, 0, 0, 0, 0, 4, 5, 9, 10, 14, 15, 20], [0, 5, 10, 15, 20], 3, { searchLimit: 0 });
  const result = chooseQuotaPath(options);
  validate(result, 3, options.pixels);
  assert.equal(result.pathStats.optimal, false);
  assert.equal(result.pathStats.visitedStates, 0);
});

test('a single-color capacity compares every allowed color even with no search budget', () => {
  const options = fixture([0, 5, 5, 5, 10, 15], [0, 5, 10, 15], 5, { locality: 0, searchLimit: 0 });
  const result = chooseQuotaPath(options);
  validate(result, 5, options.pixels);
  assert.deepEqual(result.palette.map(entry => entry.color), [5]);
  assert.equal(result.pathStats.comparedPlans, 4);
  assert.equal(result.pathStats.optimal, true);
});

test('sixteen competing colors finish within the state budget with valid final quotas', () => {
  const palette = Array.from({ length: 16 }, (_, c) => ({ id: String(c), color: c * 8 }));
  const pixels = Array(48 * 48).fill('0');
  for (let c = 1; c < 16; c++) pixels[c * 100] = String(c);
  const samples = pixels.map((id, i) => ({ i, lab: palette[Number(id)].color, weight: 1 }));
  const result = chooseQuotaPath({ palette, pixels, samples, width: 48, minPixels: 32,
    distance: (a, b) => Math.abs(a - b), colorLab: color => color });
  validate(result, 32, pixels);
  assert.ok(result.pathStats.visitedStates <= 96);
  assert.ok(result.pathStats.comparedPlans <= 112);
  assert.ok(result.palette.some(entry => entry.id === '0'), 'initially compliant colors must stay');
});
