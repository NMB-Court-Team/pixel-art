const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const PixelImportOptimizer = require('../js/import-optimizer.js');

// Exercise the actual import pipeline without starting the editor or exposing
// test-only hooks in the production app.
const source = fs.readFileSync(require.resolve('../js/app.js'), 'utf8');
const startup = 'try{init()}catch(error){showStartupError(error)}';
assert.ok(source.includes(startup));
const context = vm.createContext({
  performance, console, PixelImportOptimizer,
  document: { querySelector: () => null }, window: { addEventListener() {} }
});
vm.runInContext(source.replace(startup, 'globalThis.pipeline={quantizeImage,state,colorLab,deltaE00,importSmallColorSummary}'), context);
const { quantizeImage, state, colorLab, deltaE00, importSmallColorSummary } = context.pipeline;

function image(colors) {
  const data = new Uint8ClampedArray(48 * 48 * 4);
  colors.forEach((rgb, i) => { if (rgb) data.set([...rgb, 255], i * 4); });
  return data;
}

function validate(result, min, max) {
  assert.ok(result.palette.length <= max);
  const ids = new Set(result.palette.map(entry => entry.id));
  for (const id of result.pixels) assert.ok(id === null || ids.has(id));
  for (let a = 0; a < result.palette.length; a++) {
    assert.ok(result.pixels.filter(id => id === result.palette[a].id).length >= min);
    for (let b = a + 1; b < result.palette.length; b++) {
      assert.ok(deltaE00(colorLab(result.palette[a].color), colorLab(result.palette[b].color)) >= state.minDeltaE);
    }
  }
}

test('import preserves a tiny distinct feature by growing it to the quota', () => {
  state.maxColors = 16; state.minDeltaE = 12; state.minColorPixels = 32;
  const colors = Array(48 * 48).fill([245, 245, 245]);
  for (let y = 20; y < 22; y++) for (let x = 20; x < 22; x++) colors[y * 48 + x] = [10, 10, 10];
  const result = quantizeImage(image(colors), { algorithm: 'perceptual' });
  validate(result, 32, 16);
  assert.equal(result.palette.length, 2);
  assert.equal(result.smallStats.expanded, 1);
  assert.equal(result.smallStats.reassigned, 28);
  const black = result.palette.find(entry => entry.color === '#0a0a0a').id;
  assert.equal(result.pixels.filter(id => id === black).length, 32);
  for (let y = 20; y < 22; y++) for (let x = 20; x < 22; x++) assert.equal(result.pixels[y * 48 + x], black);
});

test('ignore skips growth, while legacy methods retain their merge behavior', () => {
  const colors = Array(48 * 48).fill([245, 245, 245]); colors[1000] = [10, 10, 10];
  const data = image(colors);
  const ignored = quantizeImage(data, { algorithm: 'perceptual', enforceMinPixels: false });
  assert.equal(ignored.palette.length, 2);
  assert.equal(ignored.smallStats.ignored, true);
  assert.equal(ignored.smallStats.reassigned, 0);
  for (const algorithm of ['none', 'shift', 'contrast', 'balanced']) {
    const result = quantizeImage(data, { algorithm });
    validate(result, 32, 16);
    assert.equal(result.smallStats.reassigned, 0);
  }
});

test('photographic gradients obey color count, rounded palette separation, and quotas', () => {
  state.maxColors = 8; state.minDeltaE = 18; state.minColorPixels = 64;
  const colors = Array.from({ length: 48 * 48 }, (_, i) => {
    const x = i % 48, y = Math.floor(i / 48);
    return [Math.round(x * 255 / 47), Math.round(y * 255 / 47), (x * 7 + y * 13) % 256];
  });
  const result = quantizeImage(image(colors), { algorithm: 'perceptual' });
  validate(result, 64, 8);
  const again = quantizeImage(image(colors), { algorithm: 'perceptual' });
  assert.deepEqual(Array.from(again.palette, entry => entry.color), Array.from(result.palette, entry => entry.color));
  const asColors = output => Array.from(output.pixels, id => output.palette.find(entry => entry.id === id)?.color);
  assert.deepEqual(asColors(result), asColors(again));
});

test('sparse input warns about infeasible quotas and retains transparency', () => {
  state.maxColors = 16; state.minDeltaE = 12; state.minColorPixels = 32;
  const result = quantizeImage(image([[0, 0, 0], [255, 255, 255], null]), { algorithm: 'perceptual' });
  assert.equal(result.smallStats.feasible, false);
  assert.equal(result.smallStats.visiblePixels, 2);
  assert.equal(result.pixels.filter(id => id != null).length, 2);
  assert.match(importSmallColorSummary(result.smallStats), /无法达到每色 32 格/);
});
