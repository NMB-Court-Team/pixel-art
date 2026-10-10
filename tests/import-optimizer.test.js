const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assignWithMinimums, growSmallColors } = require('../js/import-optimizer.js');

function bruteForceCost(costs, min) {
  const k = costs[0].length, counts = Array(k).fill(0);
  let best = Infinity;
  function visit(p, cost) {
    if (p === costs.length) {
      if (counts.every(n => n >= min)) best = Math.min(best, cost);
      return;
    }
    for (let c = 0; c < k; c++) {
      counts[c]++; visit(p + 1, cost + costs[p][c]); counts[c]--;
    }
  }
  visit(0, 0);
  return best;
}

test('quota assignment agrees with exhaustive search, including competing deficits and relay paths', () => {
  let seed = 12345;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let trial = 0; trial < 300; trial++) {
    const k = 2 + trial % 2, min = 1 + trial % 2, n = k * min + trial % 3;
    const costs = Array.from({ length: n }, () => Array.from({ length: k }, () => Math.floor(random() * 30)));
    const labels = assignWithMinimums(costs, min);
    const counts = Array(k).fill(0);
    labels.forEach(c => counts[c]++);
    assert.ok(counts.every(count => count >= min));
    assert.equal(labels.reduce((sum, c, p) => sum + costs[p][c], 0), bruteForceCost(costs, min), `trial ${trial}`);
    assert.deepEqual(assignWithMinimums(costs, min), labels);
  }
});

test('a color at its minimum can relay a cheaper reassignment without losing its quota', () => {
  const costs = [[0, 100, 100], [0, 1, 100], [100, 0, 1]];
  assert.deepEqual(assignWithMinimums(costs, 1), [0, 1, 2]);
});

function grow(pixels, minPixels, values = [0, 10, 20], width = pixels.length) {
  return growSmallColors({
    palette: values.map((color, i) => ({ id: String(i), color })), pixels,
    samples: pixels.flatMap((id, i) => id == null ? [] : [{ i, lab: values[Number(id)], weight: 1 }]),
    width, minPixels, colorLab: color => color, distance: (a, b) => Math.abs(a - b), locality: 9
  });
}

test('small detail grows at its boundary, donors keep their minimum, and transparency is preserved', () => {
  const pixels = ['0', '0', '0', '0', '1', null];
  const result = grow(pixels, 2, [0, 10]);
  assert.deepEqual(result.pixels, ['0', '0', '0', '1', '1', null]);
  assert.deepEqual(pixels, ['0', '0', '0', '0', '1', null]);
  assert.equal(result.mergedCount, 0);
  assert.equal(result.expandedColors, 1);
  assert.equal(result.reassignedPixels, 1);
  assert.equal(result.feasible, true);
});

test('all colors below minimum are preserved if total capacity is sufficient', () => {
  const result = grow(['0', '0', '0', '0', '1', '2'], 2);
  assert.equal(result.palette.length, 3);
  for (const entry of result.palette) assert.equal(result.pixels.filter(id => id === entry.id).length, 2);
});

test('capacity shortage merges the least costly color and still satisfies remaining quotas', () => {
  const result = grow(['0', '0', '0', '1', '2'], 2, [0, 1, 100]);
  assert.equal(result.mergedCount, 1);
  assert.equal(result.palette.length, 2);
  assert.ok(result.palette.some(entry => entry.id === '2'));
  for (const entry of result.palette) assert.ok(result.pixels.filter(id => id === entry.id).length >= 2);
});

test('fewer visible cells than one quota reports infeasibility without painting transparent cells', () => {
  const result = grow(['0', null, '1'], 4, [0, 10]);
  assert.equal(result.palette.length, 1);
  assert.equal(result.feasible, false);
  assert.equal(result.visiblePixels, 2);
  assert.equal(result.pixels[1], null);
});

test('valid images and empty images are unchanged', () => {
  assert.deepEqual(grow(['0', '0', '1', '1'], 2, [0, 10]).pixels, ['0', '0', '1', '1']);
  assert.deepEqual(grow([null, null], 2).pixels, [null, null]);
});

test('disconnected components can satisfy global quotas without filling their transparent gap', () => {
  const result = grow(['0', '0', '0', null, '1'], 2, [0, 10]);
  assert.equal(result.pixels[3], null);
  assert.equal(result.palette.length, 2);
  for (const entry of result.palette) assert.equal(result.pixels.filter(id => id === entry.id).length, 2);
});

test('48 by 48 assignment supports sixteen competing colors', () => {
  const pixels = Array(48 * 48).fill('0');
  for (let c = 1; c < 16; c++) pixels[c * 100] = String(c);
  const result = grow(pixels, 32, Array.from({ length: 16 }, (_, i) => i * 8), 48);
  assert.equal(result.palette.length, 16);
  for (const entry of result.palette) assert.ok(result.pixels.filter(id => id === entry.id).length >= 32);
});
