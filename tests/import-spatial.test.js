const { test } = require('node:test');
const assert = require('node:assert/strict');
const { balanceSpatialColors } = require('../js/import-optimizer.js');

// Scalar distances make the spatial tradeoffs explicit, independent of CIEDE2000.
function fixture(values, labels, options = {}) {
  return { palette: [{ id: 'a', color: 0 }, { id: 'b', color: 10 }],
    pixels: labels, samples: values.flatMap((lab, i) => lab === null ? [] : [{ i, lab, weight: 1 }]),
    width: values.length, minPixels: 1, distance: (a, b) => Math.abs(a - b), colorLab: color => color,
    enforceMinPixels: false, contrastStrength: 100, ...options };
}

test('weak-edge isolated labels smooth out while a real source edge survives', () => {
  const result = balanceSpatialColors(fixture([0, 4.5, 5.1, 4.5, 0, 10, 10, 10], ['a', 'a', 'b', 'a', 'a', 'b', 'b', 'b']));
  assert.deepEqual(result.pixels, ['a', 'a', 'a', 'a', 'a', 'b', 'b', 'b']);
  assert.ok(result.spatialStats.energyAfter < result.spatialStats.energyBefore);
});

test('strong source edges resist collapsing and the protection target respects its cap', () => {
  const options = fixture([-4, 4.9, null, 10], ['a', 'a', null, 'b'], { regionThreshold: .5 });
  const protectedEdge = balanceSpatialColors(options);
  assert.deepEqual(protectedEdge.pixels, ['a', 'b', null, 'b']);
  assert.ok(protectedEdge.spatialStats.energyAfter < protectedEdge.spatialStats.energyBefore);
  const capped = balanceSpatialColors({ ...options, contrastTarget: 1 });
  assert.deepEqual(capped.pixels, options.pixels);
});

test('quota-preserving descent handles swaps and transparent holes deterministically', () => {
  const options = fixture([0, 4.9, 5.1, null, 4.9, 0, 10, 10, 10], ['a', 'a', 'b', null, 'a', 'a', 'b', 'b', 'b'],
    { enforceMinPixels: true, minPixels: 4 });
  const result = balanceSpatialColors(options);
  assert.equal(result.pixels[3], null);
  assert.equal(result.pixels.filter(id => id === 'a').length, 4);
  assert.equal(result.pixels.filter(id => id === 'b').length, 4);
  assert.ok(result.spatialStats.energyAfter <= result.spatialStats.energyBefore + 1e-8);
  assert.deepEqual(result, balanceSpatialColors(options));
});

test('many small grids retain quotas and never increase the accepted spatial objective', () => {
  let seed = 1729;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 100; trial++) {
    const values = Array.from({ length: 24 }, () => random() < .1 ? null : random() * 10);
    values[0] = 0; values[1] = 10;
    const pixels = values.map(v => v === null ? null : v < 5 ? 'a' : 'b');
    const result = balanceSpatialColors(fixture(values, pixels, { width: 6, minPixels: 6, enforceMinPixels: true }));
    for (const entry of result.palette) assert.ok(result.pixels.filter(id => id === entry.id).length >= 6);
    values.forEach((v, i) => assert.equal(result.pixels[i] === null, v === null));
    assert.ok(result.spatialStats.energyAfter <= result.spatialStats.energyBefore + 1e-8);
  }
});
