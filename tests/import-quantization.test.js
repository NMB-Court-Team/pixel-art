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
  for (const algorithm of ['none', 'shift', 'contrast']) {
    const result = quantizeImage(data, { algorithm });
    validate(result, 32, 16);
    assert.equal(result.smallStats.reassigned, 0);
  }
});

const asColors = output => Array.from(output.pixels, id => output.palette.find(entry => entry.id === id)?.color || null);

test('adaptive shift is an exact clone of shift when quota handling is ignored', () => {
  state.maxColors = 8; state.minDeltaE = 12; state.minColorPixels = 32;
  const data = image(Array.from({ length: 48 * 48 }, (_, i) => i % 31 === 0 ? null :
    [[110, 70, 60], [125, 80, 70], [140, 90, 80], [200, 200, 200]][i % 4]));
  const original = quantizeImage(data, { algorithm: 'shift', enforceMinPixels: false });
  const result = quantizeImage(data, { algorithm: 'shift-adaptive', enforceMinPixels: false });
  assert.deepEqual(asColors(result), asColors(original));
  assert.equal(result.recoveredCount, original.recoveredCount);
  assert.ok(result.recoveredCount > 0, 'fixture must exercise shifted-color recovery');
  assert.equal(result.smallStats.ignored, true);
  assert.equal(result.smallStats.reassigned, 0);
});

test('adaptive shift can merge despite spare capacity and preserves all import constraints', () => {
  state.maxColors = 16; state.minDeltaE = 12; state.minColorPixels = 32;
  const colors = Array(48 * 48).fill([245, 245, 245]); colors[1000] = [10, 10, 10];
  const result = quantizeImage(image(colors), { algorithm: 'shift-adaptive' });
  validate(result, 32, 16);
  assert.equal(result.palette.length, 1);
  assert.equal(result.smallStats.merged, 1);
  assert.equal(result.smallStats.reassigned, 1);
  assert.match(importSmallColorSummary(result.smallStats), /比较 2 方案/);
});

test('adaptive shift grows a nearly compliant detail that original shift would merge', () => {
  state.maxColors = 16; state.minDeltaE = 12; state.minColorPixels = 32;
  const colors = Array(48 * 48).fill([245, 245, 245]);
  for (let y = 20; y < 25; y++) for (let x = 20; x < 26; x++) colors[y * 48 + x] = [10, 10, 10];
  const data = image(colors);
  const original = quantizeImage(data, { algorithm: 'shift' });
  assert.equal(original.palette.length, 1);
  const result = quantizeImage(data, { algorithm: 'shift-adaptive' });
  validate(result, 32, 16);
  assert.equal(result.palette.length, 2);
  assert.equal(result.smallStats.expanded, 1);
  assert.equal(result.smallStats.merged, 0);
  assert.equal(result.smallStats.reassigned, 2);
  const black = result.palette.find(entry => entry.color === '#0a0a0a').id;
  for (let y = 20; y < 25; y++) for (let x = 20; x < 26; x++) assert.equal(result.pixels[y * 48 + x], black);
});

test('balanced retains dark eye cores and fills their quota without shifting the palette', () => {
  state.maxColors = 16; state.minDeltaE = 8; state.minColorPixels = 32;
  const colors = Array(48 * 48).fill([48, 48, 48]);
  const eyes = [20 * 48 + 18, 20 * 48 + 19, 20 * 48 + 28, 20 * 48 + 29];
  eyes.forEach(i => { colors[i] = [3, 3, 3]; });
  const result = quantizeImage(image(colors), { algorithm: 'balanced' });
  validate(result, 32, 16);
  assert.equal(result.palette.length, 2);
  assert.equal(result.recoveredCount, 0);
  assert.equal(result.smallStats.expanded, 1);
  assert.equal(result.pixels.filter(id => id === result.palette.find(entry => entry.color === '#030303').id).length, 32);
  eyes.forEach(i => assert.equal(asColors(result)[i], '#030303'));
  assert.ok(result.spatialStats.energyAfter <= result.spatialStats.energyBefore + 1e-8);
});

test('balanced allows weakly different neighbors to share one color instead of creating contrast', () => {
  state.maxColors = 16; state.minDeltaE = 12; state.minColorPixels = 32;
  const colors = Array.from({ length: 48 * 48 }, (_, i) => {
    if (i % 48 < 8) return [0, 0, 0];
    if (i % 48 > 39) return [255, 255, 255];
    return i % 2 ? [115, 115, 115] : [120, 120, 120];
  });
  const data = image(colors);
  const baseline = quantizeImage(data, { algorithm: 'perceptual' });
  const result = quantizeImage(data, { algorithm: 'balanced', contrastStrength: 100 });
  assert.deepEqual(asColors(result), asColors(baseline));
  validate(result, 32, 16);
});

test('balanced zero strength exactly matches perceptual, with or without quotas', () => {
  state.maxColors = 6; state.minDeltaE = 12; state.minColorPixels = 64;
  const colors = Array.from({ length: 48 * 48 }, (_, i) => i % 13 === 0 ? null : [i % 256, Math.floor(i / 48) * 5, (i * 3) % 256]);
  const data = image(colors);
  for (const enforceMinPixels of [false, true]) {
    const baseline = quantizeImage(data, { algorithm: 'perceptual', enforceMinPixels });
    const result = quantizeImage(data, { algorithm: 'balanced', contrastStrength: 0, enforceMinPixels });
    assert.deepEqual(asColors(result), asColors(baseline));
  }
});

test('balanced keeps a smooth gradient distinct, deterministic, separated, and quota compliant', () => {
  state.maxColors = 8; state.minDeltaE = 8; state.minColorPixels = 64;
  const colors = Array.from({ length: 48 * 48 }, (_, i) => {
    const gray = Math.round(16 + i % 48 * 208 / 47);
    return [gray, gray, gray];
  });
  const data = image(colors), result = quantizeImage(data, { algorithm: 'balanced' });
  validate(result, 64, 8);
  assert.ok(result.palette.length >= 6, 'transitive source similarity must not collapse the gradient into one region');
  assert.ok(result.spatialStats.energyAfter <= result.spatialStats.energyBefore + 1e-8);
  assert.deepEqual(asColors(result), asColors(quantizeImage(data, { algorithm: 'balanced' })));
});

test('balanced ignore preserves tiny features without quota growth and reports sparse infeasibility', () => {
  state.maxColors = 16; state.minDeltaE = 12; state.minColorPixels = 32;
  const data = image([[0, 0, 0], null, [255, 255, 255]]);
  const ignored = quantizeImage(data, { algorithm: 'balanced', enforceMinPixels: false });
  assert.equal(ignored.palette.length, 2);
  assert.equal(ignored.smallStats.ignored, true);
  assert.equal(ignored.pixels.filter(id => id !== null).length, 2);
  const result = quantizeImage(data, { algorithm: 'balanced' });
  assert.equal(result.smallStats.feasible, false);
  assert.equal(result.pixels.filter(id => id !== null).length, 2);
  assert.match(importSmallColorSummary(result.smallStats), /无法达到每色 32 格/);
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
