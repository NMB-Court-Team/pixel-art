/*!
 * png-indexed.js —— 纯前端"索引色"PNG 编码器（颜色类型 3 / palette）
 *
 * 输出是标准 PNG（IHDR/PLTE/tRNS/IDAT/IEND），无任何私有 chunk：
 *   - PLTE  = 调色板（RGB 三元组）
 *   - tRNS  = 每个调色板条目一个 alpha；带透明时在调色板末尾追加一个
 *             alpha=0 的透明槽位
 *   - 位深按调色板条目数自动取最小可用值 1/2/4/8
 *   - 每行做 PNG 自适应滤波（None/Sub/Up/Average/Paeth 取启发式最小代价），
 *     IDAT 用标准 zlib（DeflateRaw + zlib 头 + Adler-32）
 *
 * 压缩使用浏览器内置 CompressionStream('deflate-raw')（异步）；若环境不可用
 * 则自动降级为不压缩的 stored block，输出仍是合法 zlib/PNG。
 *
 * 用法（浏览器挂 window.PngIndexed，Node 走 module.exports）：
 *   const bytes = await PngIndexed.encode({
 *     width, height,
 *     colors: [[r,g,b], ...] 或 [{r,g,b}, ...],
 *     rows:   每行一个数组，元素为 colors 索引；-1 表示透明像素
 *     hasTransparent: true/false   // 是否存在 -1；决定是否追加透明槽位
 *   });
 *   // bytes: Uint8Array，可直接 new Blob([bytes], {type:'image/png'})
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PngIndexed = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------- 基础工具
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(tag, data) {
    const length = data.length;
    const buf = new Uint8Array(length + 12);
    const view = new DataView(buf.buffer);
    view.setUint32(0, length);
    for (let i = 0; i < 4; i++) buf[4 + i] = tag.charCodeAt(i);
    buf.set(data, 8);
    view.setUint32(8 + length, crc32(buf.subarray(4, 8 + length)));
    return buf;
  }

  // ------------------------------------------------------------- 位打包/滤波
  function pickDepth(entries) {
    for (const d of [1, 2, 4, 8]) if ((1 << d) >= entries) return d;
    return 8;
  }

  function packRow(vals, depth) {
    const width = vals.length;
    if (depth === 8) {
      const out = new Uint8Array(width);
      out.set(vals);
      return out;
    }
    const out = new Uint8Array(Math.ceil(width / (8 / depth)));
    for (let i = 0; i < width; i++) {
      const bit = i * depth;
      out[bit >> 3] |= vals[i] << (8 - depth - (bit & 7));
    }
    return out;
  }

  // bpp：索引色 PNG（单通道、位深 ≤ 8）滤波时每像素按 1 字节计
  function filterScanlines(packedRows) {
    const parts = [];
    let prev = null;
    for (const raw of packedRows) {
      const n = raw.length;
      let bestFilter = 0, bestCost = Infinity, bestRow = null;
      for (let f = 0; f < 5; f++) {
        const fb = new Int16Array(n);
        for (let i = 0; i < n; i++) {
          const a = i > 0 ? raw[i - 1] : 0;
          const b = prev ? prev[i] : 0;
          const c = (prev && i > 0) ? prev[i - 1] : 0;
          let v;
          if (f === 0) v = raw[i];
          else if (f === 1) v = raw[i] - a;
          else if (f === 2) v = raw[i] - b;
          else if (f === 3) v = raw[i] - ((a + b) >> 1);
          else {
            const p = a + b - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            v = raw[i] - (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
          }
          fb[i] = v;
        }
        let cost = 0;
        for (let i = 0; i < n; i++) cost += fb[i] < 0 ? -fb[i] : fb[i];
        if (cost < bestCost) { bestCost = cost; bestFilter = f; bestRow = fb; }
      }
      parts.push(bestFilter);
      for (let i = 0; i < n; i++) parts.push(bestRow[i] & 255);
      prev = raw;
    }
    return Uint8Array.from(parts);
  }

  // ------------------------------------------------------------- DeflateRaw
  function deflateStored(data) {
    // 无 CompressionStream 时的兜底：stored block（不压缩，但仍是合法 deflate）
    const blocks = [];
    let pos = 0;
    while (pos < data.length) {
      const length = Math.min(65535, data.length - pos);
      const final = pos + length >= data.length ? 1 : 0;
      const head = new Uint8Array(5);
      head[0] = final;
      head[1] = length & 255;
      head[2] = (length >>> 8) & 255;
      const nlen = (~length) & 0xFFFF;
      head[3] = nlen & 255;
      head[4] = (nlen >>> 8) & 255;
      blocks.push(head, data.subarray(pos, pos + length));
      pos += length;
    }
    let total = 0;
    blocks.forEach(b => { total += b.length; });
    const out = new Uint8Array(total);
    let off = 0;
    blocks.forEach(b => { out.set(b, off); off += b.length; });
    return out;
  }

  async function deflateRaw(data) {
    if (typeof CompressionStream !== 'undefined') {
      try {
        const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (error) {
        /* 环境异常时降级到 stored block */
      }
    }
    return deflateStored(data);
  }


  // ------------------------------------------------------------- 主入口
  function normalizeColor(color) {
    if (color && typeof color === 'object') {
      const r = color.length === 3 ? color[0] : color.r;
      const g = color.length === 3 ? color[1] : color.g;
      const b = color.length === 3 ? color[2] : color.b;
      return [r | 0, g | 0, b | 0];
    }
    throw new Error('调色板颜色格式必须是 [r,g,b] 或 {r,g,b}');
  }

  async function encode(options) {
    const width = options.width | 0;
    const height = options.height | 0;
    const colors = (options.colors || []).map(normalizeColor);
    const rows = options.rows;
    const hasTransparent = !!options.hasTransparent;
    if (width <= 0 || height <= 0) throw new Error('宽高必须为正整数');
    if (!rows || rows.length !== height) throw new Error('rows 行数必须等于 height');
    const transparentSlot = hasTransparent ? colors.length : -1;
    const entries = colors.length + (hasTransparent ? 1 : 0);
    if (entries === 0) throw new Error('没有调色板颜色也没有透明像素，无内容可编码');
    if (entries > 256) throw new Error('调色板条目超过 256 上限');

    const packedRows = new Array(height);
    for (let y = 0; y < height; y++) {
      const row = rows[y];
      if (!row || row.length !== width) throw new Error(`第 ${y} 行长度不等于 width`);
      const vals = new Uint8Array(width);
      for (let x = 0; x < width; x++) {
        const v = row[x];
        if (v === -1 || v === null) {
          if (!hasTransparent) throw new Error(`第 ${y} 行存在透明像素但未声明 hasTransparent`);
          vals[x] = transparentSlot;
        } else {
          const index = v | 0;
          if (index < 0 || index >= colors.length) throw new Error(`第 ${y} 行索引越界: ${v}`);
          vals[x] = index;
        }
      }
      packedRows[y] = packRow(vals, pickDepth(entries));
    }

    const scanlines = filterScanlines(packedRows);
    const raw = await deflateRaw(scanlines);

    // zlib 包裹：头 + deflate + Adler-32（Adler-32 对过滤后的原始 scanline 流计算）
    let a = 1, b = 0;
    for (let i = 0; i < scanlines.length; i++) {
      a = (a + scanlines[i]) % 65521;
      b = (b + a) % 65521;
    }
    const adler = ((b << 16) | a) >>> 0;
    const idat = new Uint8Array(raw.length + 6);
    idat[0] = 0x78;
    idat[1] = 0x9C;
    idat.set(raw, 2);
    idat[idat.length - 4] = (adler >>> 24) & 255;
    idat[idat.length - 3] = (adler >>> 16) & 255;
    idat[idat.length - 2] = (adler >>> 8) & 255;
    idat[idat.length - 1] = adler & 255;

    const paletteBytes = new Uint8Array(entries * 3);
    for (let i = 0; i < colors.length; i++) {
      paletteBytes[i * 3] = colors[i][0];
      paletteBytes[i * 3 + 1] = colors[i][1];
      paletteBytes[i * 3 + 2] = colors[i][2];
    }
    if (hasTransparent) {
      const i = colors.length * 3;
      paletteBytes[i] = 0; paletteBytes[i + 1] = 0; paletteBytes[i + 2] = 0;
    }

    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr[8] = pickDepth(entries);   // bit depth
    ihdr[9] = 3;                    // color type: indexed
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    let trns = null;
    if (hasTransparent) {
      trns = new Uint8Array(entries).fill(255);
      trns[colors.length] = 0;      // 透明槽位 alpha=0
    }

    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('PLTE', paletteBytes)];
    if (trns) parts.push(chunk('tRNS', trns));
    parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));

    let total = 0;
    parts.forEach(p => { total += p.length; });
    const output = new Uint8Array(total);
    let offset = 0;
    parts.forEach(p => { output.set(p, offset); offset += p.length; });
    return output;
  }

  return { encode, pickDepth, packRow };
});
