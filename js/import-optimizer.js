/* Import-only quota assignment. No DOM, dependencies, or changes to transparent cells. */
(function (root) {
  'use strict';
  const EPS = 1e-8;

  class MinHeap {
    constructor() { this.items = []; }
    push(item) {
      const a = this.items;
      let i = a.length;
      a.push(item);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p].cost <= item.cost) break;
        a[i] = a[p]; i = p;
      }
      a[i] = item;
    }
    pop() {
      const a = this.items, first = a[0], last = a.pop();
      if (a.length) {
        let i = 0;
        while (i * 2 + 1 < a.length) {
          let child = i * 2 + 1;
          if (child + 1 < a.length && a[child + 1].cost < a[child].cost) child++;
          if (a[child].cost >= last.cost) break;
          a[i] = a[child]; i = child;
        }
        a[i] = last;
      }
      return first;
    }
    peek() { return this.items[0]; }
  }

  // Exact minimum-cost assignment for FIXED per-pixel costs and lower quotas.
  // Start at the unconstrained optimum. Each residual color -> color edge moves
  // its cheapest pixel. A shortest augmenting path can relay through a color
  // already at its quota, so it does not have to sacrifice that color's count.
  function assignWithMinimums(costs, minimum) {
    if (!costs.length) return [];
    const k = costs[0].length, n = costs.length;
    if (!k || n < k * minimum) throw new Error('可见格子不足以满足颜色配额');
    const labels = new Int32Array(n), counts = new Int32Array(k);
    const versions = new Int32Array(n);
    const heaps = Array.from({ length: k }, () => Array.from({ length: k }, () => new MinHeap()));
    const addPixel = p => {
      const from = labels[p];
      for (let to = 0; to < k; to++) if (to !== from) {
        heaps[from][to].push({ p, version: versions[p], cost: costs[p][to] - costs[p][from] });
      }
    };
    for (let p = 0; p < n; p++) {
      let best = 0;
      for (let c = 1; c < k; c++) if (costs[p][c] < costs[p][best] - EPS) best = c;
      labels[p] = best; counts[best]++;
    }
    for (let p = 0; p < n; p++) addPixel(p);
    while (counts.some(count => count < minimum)) {
      const edges = heaps.map((row, from) => row.map((heap, to) => {
        if (from === to) return null;
        while (heap.peek() && (labels[heap.peek().p] !== from || versions[heap.peek().p] !== heap.peek().version)) heap.pop();
        return heap.peek() || null;
      }));
      const distances = Array.from(counts, count => count > minimum ? 0 : Infinity);
      const paths = Array.from({ length: k }, () => []);
      // Bellman-Ford: reverse residual edges may have negative costs.
      for (let pass = 0; pass < k - 1; pass++) {
        const next = [...distances], nextPaths = [...paths];
        let changed = false;
        for (let from = 0; from < k; from++) {
          if (!Number.isFinite(distances[from])) continue;
          for (let to = 0; to < k; to++) {
            const edge = edges[from][to];
            if (edge && distances[from] + edge.cost < next[to] - EPS) {
              next[to] = distances[from] + edge.cost;
              nextPaths[to] = [...paths[from], { from, to, p: edge.p }];
              changed = true;
            }
          }
        }
        for (let c = 0; c < k; c++) { distances[c] = next[c]; paths[c] = nextPaths[c]; }
        if (!changed) break;
      }
      let target = -1;
      for (let c = 0; c < k; c++) if (counts[c] < minimum && (target < 0 || distances[c] < distances[target] - EPS)) target = c;
      const path = paths[target];
      if (!path?.length) throw new Error('颜色配额分配失败');
      for (const { from, to, p } of path) {
        labels[p] = to; counts[from]--; counts[to]++; versions[p]++;
      }
      for (const { p } of path) addPixel(p);
    }
    return [...labels];
  }

  function growSmallColors({ palette, pixels, samples, width, minPixels, distance, colorLab, locality = 9 }) {
    const originalCounts = new Map();
    for (const id of pixels) if (id != null) originalCounts.set(id, (originalCounts.get(id) || 0) + 1);
    let active = palette.filter(entry => originalCounts.has(entry.id));
    const original = [...pixels], output = [...pixels], n = samples.length;
    const finish = (labels, mergedCount) => {
      samples.forEach((sample, p) => { output[sample.i] = active[labels[p]].id; });
      const counts = new Map();
      for (const id of output) if (id != null) counts.set(id, (counts.get(id) || 0) + 1);
      return {
        palette: active, pixels: output, mergedCount,
        expandedColors: active.filter(entry => counts.get(entry.id) > (originalCounts.get(entry.id) || 0) && (originalCounts.get(entry.id) || 0) < minPixels).length,
        reassignedPixels: output.filter((id, i) => id !== original[i]).length,
        feasible: n === 0 || n >= minPixels, visiblePixels: n, requiredPixels: minPixels
      };
    };
    if (!n || !active.length) return { palette: [], pixels: output, mergedCount: 0, expandedColors: 0, reassignedPixels: 0, feasible: true, visiblePixels: n, requiredPixels: minPixels };
    if (active.every(entry => originalCounts.get(entry.id) >= minPixels)) return finish(samples.map(sample => active.findIndex(entry => entry.id === pixels[sample.i])), 0);
    const allLabs = new Map(active.map(entry => [entry.id, colorLab(entry.color)]));
    const rawCosts = samples.map(sample => new Map(active.map(entry => [entry.id, sample.weight * distance(sample.lab, allLabs.get(entry.id)) ** 2])));
    const nearestLabels = () => rawCosts.map(row => {
      let best = 0;
      for (let c = 1; c < active.length; c++) if (row.get(active[c].id) < row.get(active[best].id) - EPS) best = c;
      return best;
    });
    const cap = Math.max(1, Math.floor(n / minPixels));
    let mergedCount = 0;
    // Palette subset selection is heuristic: remove the color with the least
    // increase in total perceptual error, reassign, then recompute the losses.
    while (active.length > cap) {
      const labels = nearestLabels();
      let remove = 0, bestLoss = Infinity;
      for (let c = 0; c < active.length; c++) {
        let loss = 0;
        for (let p = 0; p < n; p++) if (labels[p] === c) {
          let alternative = Infinity;
          for (let to = 0; to < active.length; to++) if (to !== c) alternative = Math.min(alternative, rawCosts[p].get(active[to].id));
          loss += alternative - rawCosts[p].get(active[c].id);
        }
        if (loss < bestLoss - EPS) { bestLoss = loss; remove = c; }
      }
      active.splice(remove, 1); mergedCount++;
    }
    const seeds = nearestLabels(), k = active.length;
    if (k === 1) return finish(seeds, mergedCount);
    const at = new Int32Array(pixels.length).fill(-1);
    samples.forEach((sample, p) => { at[sample.i] = p; });
    const costs = samples.map((sample, p) => active.map(entry => rawCosts[p].get(entry.id)));
    // Fixed spatial prior: four-neighbor distance to each original color region.
    // Transparent gaps block the search. This favors compact boundary growth,
    // but quotas may still require distant cells; connectivity is not a rule.
    for (let c = 0; c < k; c++) {
      const steps = new Int32Array(pixels.length).fill(-1), queue = [];
      samples.forEach((sample, p) => { if (seeds[p] === c) { steps[sample.i] = 0; queue.push(sample.i); } });
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head], x = i % width;
        for (const j of [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, i - width, i + width]) {
          if (j < 0 || j >= at.length || at[j] < 0 || steps[j] >= 0) continue;
          steps[j] = steps[i] + 1; queue.push(j);
        }
      }
      samples.forEach((sample, p) => {
        const d = steps[sample.i] < 0 ? pixels.length : steps[sample.i];
        costs[p][c] += locality * d * d;
      });
    }
    return finish(assignWithMinimums(costs, minPixels), mergedCount);
  }

  const api = { assignWithMinimums, growSmallColors };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PixelImportOptimizer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
