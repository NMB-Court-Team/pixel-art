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

  // Edge-aware pixel labeling with hard color quotas. Fidelity sums over ALL
  // pixels. Pair costs smooth weak source edges and preserve strong source
  // edges, never requesting more contrast than the source actually contains.
  // Quota flow proposes joint moves; exact full-energy acceptance plus local
  // descent prevents oscillation. The pairwise objective is not globally solved.
  function balanceSpatialColors({ palette, pixels, samples, width, minPixels, distance, colorLab,
    regionThreshold = 3, contrastTarget = 12, contrastStrength = 65, enforceMinPixels = true, locality = 9 }) {
    const small = enforceMinPixels
      ? growSmallColors({ palette, pixels, samples, width, minPixels, distance, colorLab, locality })
      : { palette: palette.filter(entry => pixels.includes(entry.id)), pixels: [...pixels], mergedCount: 0,
        expandedColors: 0, reassignedPixels: 0, feasible: true };
    const active = small.palette, n = samples.length, k = active.length;
    const strength = Math.max(0, Math.min(1, contrastStrength / 100));
    if (k < 2 || !n || !strength) return { ...small, spatialStats: { reassignedPixels: 0, energyBefore: 0, energyAfter: 0 } };
    const threshold = Math.max(.5, regionThreshold), target = Math.max(0, contrastTarget);
    const labs = active.map(entry => colorLab(entry.color));
    const paletteDistances = labs.map(a => labs.map(b => distance(a, b)));
    const ids = new Map(active.map((entry, c) => [entry.id, c]));
    let labels = samples.map(sample => ids.get(small.pixels[sample.i]));
    const initial = [...labels], counts = Array(k).fill(0);
    labels.forEach(c => counts[c]++);
    const minimum = enforceMinPixels ? minPixels : 0;
    const unary = samples.map(sample => labs.map(lab => sample.weight * distance(sample.lab, lab) ** 2));
    const at = new Int32Array(pixels.length).fill(-1);
    samples.forEach((sample, p) => { at[sample.i] = p; });
    const edges = [], neighbors = samples.map(() => []);
    samples.forEach((sample, p) => {
      const x = sample.i % width;
      for (const i of [x + 1 < width ? sample.i + 1 : -1, sample.i + width]) {
        if (i < 0 || i >= at.length || at[i] < 0) continue;
        const q = at[i], d = distance(sample.lab, samples[q].lab);
        const weight = Math.min(sample.weight, samples[q].weight) * strength;
        const smooth = weight * threshold ** 2 * Math.exp(-((d / threshold) ** 2));
        const edgeWeight = Math.max(0, Math.min(1, (d - 2 * threshold) / (2 * threshold)));
        const desired = Math.min(d, target);
        const costs = labs.map((a, ca) => labs.map((b, cb) =>
          (ca === cb ? 0 : smooth) + .35 * weight * edgeWeight * Math.max(0, desired - paletteDistances[ca][cb]) ** 2));
        const edge = { p, q, costs };
        edges.push(edge); neighbors[p].push({ other: q, costs }); neighbors[q].push({ other: p, costs });
      }
    });
    const energy = assigned => {
      let total = 0;
      for (let p = 0; p < n; p++) total += unary[p][assigned[p]];
      for (const edge of edges) total += edge.costs[assigned[edge.p]][assigned[edge.q]];
      return total;
    };
    const energyBefore = energy(labels);
    let currentEnergy = energyBefore, acceptedPasses = 0;
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      // Fixed-neighbor surrogate allows quota-preserving relay and swap moves.
      // It is only a proposal: accept against the true, symmetric energy.
      const costs = unary.map((row, p) => row.map((cost, c) => cost +
        neighbors[p].reduce((sum, edge) => sum + .5 * edge.costs[c][labels[edge.other]], 0)));
      const proposed = assignWithMinimums(costs, minimum), proposedEnergy = energy(proposed);
      if (proposedEnergy < currentEnergy - EPS) {
        labels = proposed; counts.fill(0); labels.forEach(c => counts[c]++);
        currentEnergy = proposedEnergy; changed = true;
      }
      // Sequential descent uses the same global objective and never takes a
      // cell from a color already at its minimum. Reverse scan on alternate passes.
      for (let step = 0; step < n; step++) {
        const p = pass % 2 ? n - 1 - step : step, from = labels[p];
        if (counts[from] <= minimum) continue;
        const localCost = c => unary[p][c] + neighbors[p].reduce((sum, edge) => sum + edge.costs[c][labels[edge.other]], 0);
        let best = from, bestCost = localCost(from);
        for (let c = 0; c < k; c++) {
          const cost = localCost(c);
          if (cost < bestCost - EPS) { best = c; bestCost = cost; }
        }
        if (best !== from) { labels[p] = best; counts[from]--; counts[best]++; changed = true; }
      }
      currentEnergy = energy(labels);
      if (!changed) break;
      acceptedPasses++;
    }
    const output = [...pixels];
    samples.forEach((sample, p) => { output[sample.i] = active[labels[p]].id; });
    const used = new Set(output.filter(id => id != null));
    const originalCounts = new Map();
    for (const id of pixels) if (id != null) originalCounts.set(id, (originalCounts.get(id) || 0) + 1);
    return { ...small, palette: active.filter(entry => used.has(entry.id)), pixels: output,
      expandedColors: active.filter((entry, c) => counts[c] > (originalCounts.get(entry.id) || 0) && (originalCounts.get(entry.id) || 0) < minPixels).length,
      reassignedPixels: output.filter((id, i) => id !== pixels[i]).length,
      spatialStats: { reassignedPixels: labels.filter((c, p) => c !== initial[p]).length, energyBefore,
        energyAfter: currentEnergy, acceptedPasses } };
  }

  // Choose between growing deficient colors and removing them. Every palette
  // subset uses the SAME fixed source-fidelity and seed-distance costs, making
  // the alternatives comparable. Each feasible assignment is solved exactly;
  // subset search is bounded (best-first with a greedy-chain incumbent).
  function chooseQuotaPath({ palette, pixels, samples, width, minPixels, distance, colorLab,
    locality = 9, searchLimit = 96 }) {
    const originalCounts = new Map();
    for (const id of pixels) if (id != null) originalCounts.set(id, (originalCounts.get(id) || 0) + 1);
    const active = palette.filter(entry => originalCounts.has(entry.id)), n = samples.length, k = active.length;
    const unchanged = { palette: active, pixels: [...pixels], mergedCount: 0, expandedColors: 0,
      reassignedPixels: 0, feasible: n === 0 || n >= minPixels, visiblePixels: n, requiredPixels: minPixels };
    if (!n || !k || active.every(entry => originalCounts.get(entry.id) >= minPixels)) return unchanged;
    const labs = active.map(entry => colorLab(entry.color));
    const at = new Int32Array(pixels.length).fill(-1);
    samples.forEach((sample, p) => { at[sample.i] = p; });
    const costs = samples.map(sample => labs.map(lab => sample.weight * distance(sample.lab, lab) ** 2));
    // Original shifted-color assignments are the seeds, not a fresh nearest-
    // color mapping. Transparent gaps block growth, and distance costs remain
    // fixed even when a candidate removes a color.
    for (let c = 0; c < k; c++) {
      const steps = new Int32Array(pixels.length).fill(-1), queue = [];
      samples.forEach(sample => { if (pixels[sample.i] === active[c].id) { steps[sample.i] = 0; queue.push(sample.i); } });
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head], x = i % width;
        for (const j of [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, i - width, i + width]) {
          if (j < 0 || j >= at.length || at[j] < 0 || steps[j] >= 0) continue;
          steps[j] = steps[i] + 1; queue.push(j);
        }
      }
      samples.forEach((sample, p) => {
        const d = steps[sample.i] < 0 ? pixels.length : steps[sample.i];
        costs[p][c] += sample.weight * locality * d * d;
      });
    }
    // Only initially deficient colors may be merged; common colors stay.
    const removable = active.flatMap((entry, c) => originalCounts.get(entry.id) < minPixels ? [c] : []);
    const minimum = Math.min(minPixels, n), fullMask = (1 << k) - 1;
    const nodes = new Map(), heap = new MinHeap();
    let best = null, comparedPlans = 0;
    const nodeFor = mask => {
      if (nodes.has(mask)) return nodes.get(mask);
      const columns = labs.flatMap((lab, c) => mask & (1 << c) ? [c] : []);
      let cost = 0;
      for (const row of costs) {
        let nearest = Infinity;
        for (const c of columns) nearest = Math.min(nearest, row[c]);
        cost += nearest;
      }
      const node = { mask, columns, cost, solved: false };
      nodes.set(mask, node); return node;
    };
    const solve = node => {
      if (node.solved || node.columns.length * minimum > n) return;
      node.solved = true; comparedPlans++;
      const labels = assignWithMinimums(costs.map(row => node.columns.map(c => row[c])), minimum);
      const score = labels.reduce((sum, label, p) => sum + costs[p][node.columns[label]], 0);
      if (!best || score < best.score - EPS || Math.abs(score - best.score) <= EPS && node.columns.length > best.columns.length) {
        best = { ...node, labels, score };
      }
    };
    const children = node => removable.flatMap(c => {
      const mask = node.mask & ~(1 << c);
      return mask && mask !== node.mask ? [nodeFor(mask)] : [];
    });
    // Seed a complete feasible result before bounded search, including when
    // total capacity cannot hold all colors. Continue the chain to compare
    // merging even when growing the full palette is already feasible.
    let visited = 0;
    const canImprove = node => node.cost < best.score - EPS ||
      node.cost <= best.score + EPS && node.columns.length > best.columns.length;
    if (n < 2 * minimum) {
      // Only one color can fit: enumerate the at-most-sixteen choices directly.
      const mandatory = active.reduce((mask, entry, c) => originalCounts.get(entry.id) >= minPixels ? mask | (1 << c) : mask, 0);
      for (let c = 0; c < k; c++) if (!mandatory || mandatory === (1 << c)) solve(nodeFor(1 << c));
    } else {
      let seed = nodeFor(fullMask);
      for (;;) {
        solve(seed);
        const next = children(seed).sort((a, b) => a.cost - b.cost || a.mask - b.mask)[0];
        if (!next) break;
        seed = next;
      }
      const queued = new Set([fullMask]);
      heap.push(nodeFor(fullMask));
      while (heap.peek() && visited < searchLimit) {
        const node = heap.pop(); visited++;
        if (!canImprove(node)) continue;
        solve(node);
        for (const child of children(node)) if (!queued.has(child.mask) && canImprove(child)) {
          queued.add(child.mask); heap.push(child);
        }
      }
    }
    const output = [...pixels], counts = Array(best.columns.length).fill(0);
    samples.forEach((sample, p) => { const c = best.labels[p]; output[sample.i] = active[best.columns[c]].id; counts[c]++; });
    const chosen = best.columns.map(c => active[c]);
    return { ...unchanged, palette: chosen, pixels: output, mergedCount: k - chosen.length,
      expandedColors: chosen.filter((entry, c) => originalCounts.get(entry.id) < minPixels && counts[c] >= minPixels).length,
      reassignedPixels: output.filter((id, i) => id !== pixels[i]).length,
      pathStats: { comparedPlans, visitedStates: visited, optimal: !heap.items.some(canImprove), cost: best.score } };
  }

  const api = { assignWithMinimums, growSmallColors, balanceSpatialColors, chooseQuotaPath };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PixelImportOptimizer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
