// 原调色板
const colorPalette = [
    "#ffffff", "#d3d3d3", "#808080", "#000000",
    "#b02e26", "#5e7c16", "#835432", "#3c44aa",
    "#8932b8", "#169c9c", "#f38baa", "#80c71f",
    "#fed83d", "#3ab3da", "#c74ebd", "#f9801d"
];
/* ====== DOM 元素 ====== */
const colorPaletteContainer = document.getElementById("colorPalette");
const exportOutput = document.getElementById("exportOutput");

/* ====== 数据结构 ====== */
let moveBackup = null;   // 存放移动前的像素数据
let isMoving = false;    // 标识当前是否在移动
let currentStep = null;       // 临时记录

/* ====== 状态 ====== */
let currentColor = "#000000";
let tool = "pen";
let symmetryMode = "none";




/* ====== 选区状态（替换逻辑） ====== */
let selectionMode = null; // 'rect' | 'free' | 'move' | 'paste' | null
let selectionPixels = new Set(); // "x,y"
let selectionBounds = null;
let clipboard = null; // {w,h,cells}
let pasteOffset = null; // {x,y}
let moveOrigin = null; // for move: array of {x,y,oldColor}
let isSelecting = false, isDraggingPaste = false;
let lastToggledKey = null;

/* ====== 像素写入 ====== */
function setPixelDirect(x, y, color) {
    pixelData[y][x] = color;
    const pixel = canvas.querySelector(`.pixel[data-x="${x}"][data-y="${y}"]`);
    if (pixel) pixel.style.backgroundColor = color;
}

function drawPixel(x, y, colorOverride = null) {
    const color = colorOverride || ((tool === "eraser") ? colorPalette[0] : currentColor);
    const pts = getSymmetryPoints(x, y);
    pts.forEach(p => {
        const oldColor = pixelData[p.y][p.x];
        if (oldColor === color) return;
        if (currentStep) currentStep.push({x: p.x, y: p.y, oldColor, newColor: color});
        setPixelDirect(p.x, p.y, color);
    });
}

/* ====== 切换工具 ======*/
function setActiveTool(toolName) {
    tool = toolName;
    document.querySelectorAll(".btn-group button").forEach(b => {
        b.classList.toggle("active", b.id === toolName);
    });
    refreshSymmetry();
}

function refreshSymmetry() {
    document.querySelectorAll(".symmetry-btn").forEach(b => {
        if (b.dataset.mode === symmetryMode) {
            b.classList.add("active")
        } else {
            b.classList.remove("active")
        }
    });
}

function setActiveSelection(btnId) {
    document.querySelectorAll('#selRect,#selFree').forEach(b => {
        b.classList.toggle('active', b.id === btnId);
    });
    refreshSymmetry();
}

/* ====== 对称点 ====== */
function getSymmetryPoints(x, y) {
    const points = [{x, y}];
    const centerX = (COLS - 1) / 2;
    const centerY = (ROWS - 1) / 2;
    switch (symmetryMode) {
        case "horizontal":
            points.push({x: COLS - 1 - x, y});
            break;
        case "vertical":
            points.push({x, y: ROWS - 1 - y});
            break;
        case "both":
            points.push({x: COLS - 1 - x, y});
            points.push({x, y: ROWS - 1 - y});
            points.push({x: COLS - 1 - x, y: ROWS - 1 - y});
            break;
        case "rotate8": {
            const dx = x - centerX, dy = y - centerY;
            points.push({x: Math.round(centerX + dy), y: Math.round(centerY + dx)});
            points.push({x: Math.round(centerX - dy), y: Math.round(centerY - dx)});
            points.push({x: Math.round(centerX + dx), y: Math.round(centerY - dy)});
            points.push({x: Math.round(centerX - dx), y: Math.round(centerY + dy)});
        }
        case "rotate4": {
            const dx = x - centerX, dy = y - centerY;
            points.push({x: Math.round(centerX - dy), y: Math.round(centerY + dx)});
            points.push({x: Math.round(centerX - dx), y: Math.round(centerY - dy)});
            points.push({x: Math.round(centerX + dy), y: Math.round(centerY - dx)});
            break;
        }

    }
    const seen = new Set();
    return points.filter(p => {
        if (p.x < 0 || p.x >= COLS || p.y < 0 || p.y >= ROWS) return false;
        const k = `${p.x},${p.y}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

// === 颜色重映射 ===
let basePalette = colorPalette.slice();     // 取当前主调色板快照（调用 initRemapPanel 时重新设）
let currentMapping = basePalette.slice();   // 当前 index -> color 映射（初始时为 identity）
let remapSelected = null;

// 初始化 / 渲染 remap 面板（调用位置：renderColorPalette() 后或 init 时）
function initRemapPanel() {
    basePalette = colorPalette.slice();
    currentMapping = basePalette.slice();

    const grid = document.getElementById("remapGrid");
    if (!grid) return; // 如果 DOM 没有这个容器就直接返回
    grid.innerHTML = "";
    basePalette.forEach((c, idx) => {
        const cell = document.createElement("div");
        cell.className = "remap-cell";
        cell.style.backgroundColor = currentMapping[idx];
        cell.dataset.index = idx;
        cell.addEventListener("click", () => onRemapClick(idx, cell));
        grid.appendChild(cell);
    });
}

// 刷新 remap 面板显示（颜色/选中状态）
function refreshRemapGrid() {
    const grid = document.getElementById("remapGrid");
    if (!grid) return;
    grid.querySelectorAll(".remap-cell").forEach(cell => {
        const idx = Number(cell.dataset.index);
        cell.style.backgroundColor = currentMapping[idx];
        cell.classList.remove("selected");
    });
    remapSelected = null;
}

/*
 applyPaletteMapping(newMapping)
  - newMapping: 长度必须等于 basePalette.length
  - 工作方式：基于 currentMapping（当前显示颜色）建反表 currentColor -> originalIndex
    对画布每像素查到 originalIndex 后用 newMapping[index] 替换像素颜色
  - 记录差异并 pushHistory, 使操作可撤回
*/
function applyPaletteMapping(newMapping) {
    if (!Array.isArray(newMapping) || newMapping.length !== basePalette.length) {
        console.warn("remap length mismatch", newMapping, basePalette);
        return;
    }

    // 反向表：当前显示颜色 -> original index
    const reverse = new Map();
    for (let i = 0; i < currentMapping.length; i++) {
        reverse.set(currentMapping[i], i);
    }

    const step = []; // 用于撤回
    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            const oldColor = pixelData[y][x];
            const idx = reverse.has(oldColor) ? reverse.get(oldColor) : undefined;
            if (typeof idx === "number") {
                const newColor = newMapping[idx];
                if (newColor !== oldColor) {
                    step.push({x, y, oldColor, newColor});
                    // 直接写 DOM & 数据
                    setPixelDirect(x, y, newColor);
                }
            }
            // 如果该像素不是调色板颜色（未在 reverse 中）, 则保持不变
        }
    }

    if (step.length > 0) pushHistory(step); // 支持撤回
    currentMapping = newMapping.slice();     // 更新当前 mapping 状态
    refreshRemapGrid();
}

// 点击 remap 单元格：实现“选两个格子互换映射并立即应用”
function onRemapClick(idx, cell) {
    if (remapSelected === null) {
        remapSelected = idx;
        cell.classList.add("selected");
        return;
    }
    if (remapSelected === idx) {
        // 取消选择
        cell.classList.remove("selected");
        remapSelected = null;
        return;
    }

    // 交换 currentMapping 的两个位置并应用
    const newMap = currentMapping.slice();
    [newMap[idx], newMap[remapSelected]] = [newMap[remapSelected], newMap[idx]];
    remapSelected = null;
    applyPaletteMapping(newMap);
}

// 随机打乱（Fisher-Yates）, 并应用到画布（可撤回）
document.getElementById("shuffleColors").addEventListener("click", () => {
    const newMap = currentMapping.slice();
    for (let i = newMap.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newMap[i], newMap[j]] = [newMap[j], newMap[i]];
    }
    applyPaletteMapping(newMap);
});

// 恢复原始顺序（把 mapping 还原为 basePalette, 然后应用）
document.getElementById("resetRemap").addEventListener("click", () => {
    applyPaletteMapping(basePalette.slice());
});

/* ====== 图形工具（preview 支持） ====== */
function getLinePixels(x1, y1, x2, y2) {
    const pixels = [];
    let dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    let sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;
    while (true) {
        pixels.push({x: x1, y: y1});
        if (x1 === x2 && y1 === y2) break;
        let e2 = 2 * err;
        if (e2 > -dy) {
            err -= dy;
            x1 += sx;
        }
        if (e2 < dx) {
            err += dx;
            y1 += sy;
        }
    }
    return pixels;
}

function getRectPixels(x1, y1, x2, y2, hollow = false) {
    const pixels = [];
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2), minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        if (hollow) {
            if (x === minX || x === maxX || y === minY || y === maxY) pixels.push({x, y});
        } else pixels.push({x, y});
    }
    return pixels;
}

function getCirclePixels(cx, cy, r, hollow = false) {
    const pixels = [];
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            const dist2 = dx * dx + dy * dy;
            if (hollow) {
                if (Math.abs(dist2 - r * r) <= Math.max(1, r)) pixels.push({x: cx + dx, y: cy + dy});
            } else {
                if (dist2 <= r * r) pixels.push({x: cx + dx, y: cy + dy});
            }
        }
    }
    return pixels;
}

/* ====== Flood Fill ====== */
function floodFill(x, y, targetColor, newColor, previewOnly = false) {
    if (targetColor === newColor) return [];
    const stack = [{x, y}];
    const visited = new Set();
    const pixels = [];
    while (stack.length) {
        const p = stack.pop();
        if (p.x < 0 || p.x >= COLS || p.y < 0 || p.y >= ROWS) continue;
        const key = `${p.x},${p.y}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (pixelData[p.y][p.x] !== targetColor) continue;
        pixels.push({x: p.x, y: p.y});
        stack.push({x: p.x + 1, y: p.y});
        stack.push({x: p.x - 1, y: p.y});
        stack.push({x: p.x, y: p.y + 1});
        stack.push({x: p.x, y: p.y - 1});
    }
    if (previewOnly) return pixels;
    const step = [];
    pixels.forEach(p => {
        step.push({x: p.x, y: p.y, oldColor: pixelData[p.y][p.x], newColor});
        setPixelDirect(p.x, p.y, newColor);
    });
    if (step.length > 0) pushHistory(step);
    return pixels;
}

/* ====== 选区工具 ====== */
function updateSelectionBounds() {
    if (selectionPixels.size === 0) {
        selectionBounds = null;
        return;
    }
    let minX = COLS, minY = ROWS, maxX = 0, maxY = 0;
    selectionPixels.forEach(k => {
        const [x, y] = k.split(',').map(Number);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    });
    selectionBounds = {minX, minY, maxX, maxY};
}

function setSelectionFromRect(x1, y1, x2, y2, add = false) {
    if (!add) selectionPixels.clear();
    const minX = Math.max(0, Math.min(x1, x2));
    const maxX = Math.min(COLS - 1, Math.max(x1, x2));
    const minY = Math.max(0, Math.min(y1, y2));
    const maxY = Math.min(ROWS - 1, Math.max(y1, y2));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) selectionPixels.add(`${x},${y}`);
    updateSelectionBounds();
    renderSelectionLayer();
}

/* 手涂选区：逐像素切换（按下并拖动会按格切换一次） */
function toggleSelectionPixel(x, y) {
    const k = `${x},${y}`;
    if (selectionPixels.has(k)) selectionPixels.delete(k);
    else selectionPixels.add(k);
    updateSelectionBounds();
    renderSelectionLayer();
}

/* 剪贴板操作 */
function copySelection() {
    if (!selectionBounds) return alert('没有选区');
    const b = selectionBounds;
    const w = b.maxX - b.minX + 1, h = b.maxY - b.minY + 1;
    const cells = Array.from({length: h}, () => Array.from({length: w}, () => null));
    for (let y = b.minY; y <= b.maxY; y++) {
        for (let x = b.minX; x <= b.maxX; x++) {
            const k = `${x},${y}`;
            if (selectionPixels.has(k)) cells[y - b.minY][x - b.minX] = pixelData[y][x];
            else cells[y - b.minY][x - b.minX] = null;
        }
    }
    clipboard = {w, h, cells};
    pasteOffset = {x: b.minX, y: b.minY};
    // clear moveOrigin if any
    moveOrigin = null;
    renderSelectionLayer();
}

function cutSelection() {
    if (!selectionBounds) return alert('没有选区');
    copySelection();
    const toColor = colorPalette[0];
    const step = [];
    selectionPixels.forEach(k => {
        const [x, y] = k.split(',').map(Number);
        step.push({x, y, oldColor: pixelData[y][x], newColor: toColor});
        setPixelDirect(x, y, toColor);
    });
    pushHistory(step);
    selectionPixels.clear();
    updateSelectionBounds();
    renderSelectionLayer();
    beginPaste()
}

/* 开始粘贴（或移动）预览 — 粘贴由 beginPaste() 启动, 回车 applyPaste() */
function beginPaste() {
    if (!clipboard) return alert('剪贴板为空');

    // currentMousePos 应该是画布格坐标 {x, y}（不是 clientX/clientY）
    const pos = (typeof currentMousePos !== 'undefined' && currentMousePos) ? currentMousePos : null;

    // 想把粘贴区域“居中放到鼠标处”, 计算期望的左上角
    const desiredX = pos ? (pos.x - Math.floor(clipboard.w / 2)) : (selectionBounds ? selectionBounds.minX : 0);
    const desiredY = pos ? (pos.y - Math.floor(clipboard.h / 2)) : (selectionBounds ? selectionBounds.minY : 0);

    // 最大允许的偏移（防止越界）, 若 clipboard 比画布大则 maxOffsetX/Y = 0
    const maxOffsetX = Math.max(0, COLS - clipboard.w);
    const maxOffsetY = Math.max(0, ROWS - clipboard.h);

    // 钳制到 [0, maxOffset]
    pasteOffset = {
        x: Math.max(0, Math.min(maxOffsetX, desiredX)),
        y: Math.max(0, Math.min(maxOffsetY, desiredY))
    };

    selectionMode = 'paste';
    renderSelectionLayer();
}

/* 移动选区（将当前选区内容复制到 clipboard, 等待粘贴；确认后原位清空） */
function beginMove() {
    if (!selectionBounds) return alert('没有选区');
    // copy selection to clipboard
    moveBackup = [];

    const b = selectionBounds;
    const w = b.maxX - b.minX + 1, h = b.maxY - b.minY + 1;
    const cells = Array.from({length: h}, () => Array.from({length: w}, () => null));
    const origin = [];
    for (let y = b.minY; y <= b.maxY; y++) {
        for (let x = b.minX; x <= b.maxX; x++) {
            const k = `${x},${y}`;
            if (selectionPixels.has(k)) {
                cells[y - b.minY][x - b.minX] = pixelData[y][x];
                origin.push({x, y, oldColor: pixelData[y][x]});
            } else cells[y - b.minY][x - b.minX] = null;
        }
    }
    clipboard = {w, h, cells};
    pasteOffset = {x: b.minX, y: b.minY};

    moveOrigin = origin; // will be cleared on confirm
    selectionMode = 'move';

    const step = [];
    // 如果是 move 操作, 清空原点（把origin像素设为空白）
    if (moveOrigin && moveOrigin.length > 0) {
        moveOrigin.forEach(o => {
            // 若原位置正好被新放置覆盖（坐标冲突）, oldColor already preserved; we still set to blank if not overlapped by new placement
            // For simplicity, set to palette[0] and record step
            step.push({x: o.x, y: o.y, oldColor: pixelData[o.y][o.x], newColor: colorPalette[0]});
            setPixelDirect(o.x, o.y, colorPalette[0]);
        });
    }
    if (step.length > 0) pushHistory(step);

    renderSelectionLayer();
}

/* 确认粘贴/移动：写入像素并记录历史（移动会同时清空原处） */
function applyPaste() {
    if (!clipboard || !pasteOffset) return;
    const step = [];
    for (let sy = 0; sy < clipboard.h; sy++) {
        for (let sx = 0; sx < clipboard.w; sx++) {
            const col = clipboard.cells[sy][sx];
            if (col == null) continue;
            const tx = pasteOffset.x + sx, ty = pasteOffset.y + sy;
            if (tx < 0 || tx >= COLS || ty < 0 || ty >= ROWS) continue;
            step.push({x: tx, y: ty, oldColor: pixelData[ty][tx], newColor: col});
            setPixelDirect(tx, ty, col);
        }
    }

    if (step.length > 0) pushHistory(step);
    // 清理
    // clipboard = null;
    pasteOffset = null;
    moveOrigin = null;
    selectionMode = null;
    setActiveSelection(null)
    selectionPixels.clear();
    updateSelectionBounds();
    renderSelectionLayer();
}

/* 取消选区/粘贴 */
function clearSelection() {
    // 否则默认只取消当前的选区显示/状态，但保留剪贴板与粘贴内容，
    // 以便用户在按 Esc 或点击“清除选区”后仍能继续粘贴之前复制的内容。
    selectionPixels.clear();
    selectionBounds = null;
    moveOrigin = null;
    // 重置交互相关标志，避免阻塞后续选区操作
    isSelecting = false;
    isDraggingPaste = false;
    // 也重置拖拽起点/上次切换的键，防止卡住
    try { dragStart = null; } catch (e) { /* dragStart 可能在另一个模块定义 */ }
    lastToggledKey = null;
    // 退出选区 UI 状态（但不要清空 clipboard/pasteOffset）
    if (selectionMode === 'rect' || selectionMode === 'free') selectionMode = null;
    setActiveSelection(null);
    renderSelectionLayer();
}

/* ====== 渲染颜色面板 ====== */
function renderColorPalette() {
    colorPaletteContainer.innerHTML = "";
    colorPalette.forEach((c, i) => {
        const b = document.createElement("div");
        b.className = "color-btn";
        b.style.backgroundColor = c;
        b.dataset.color = c;
        b.title = `${i}: ${c}`;
        if (i === 3) b.classList.add("selected");
        b.addEventListener("click", () => {
            document.querySelectorAll(".color-btn").forEach(x => x.classList.remove("selected"));
            b.classList.add("selected");
            currentColor = c;
        });
        colorPaletteContainer.appendChild(b);
    });
    const info = document.createElement("div");
    info.style.cssText = "width:100%;text-align:center;margin-top:6px;font-size:12px;color:#666";
    //info.textContent = `${colorPalette.length} / 16 颜色`;
    colorPaletteContainer.appendChild(info);
}

/* ====== 导出/导入（恢复原版格式） ====== */
function exportAsText() {
    let out = "";
    for (let y = 0; y < ROWS; y++) {
        out += "- [";
        const row = [];
        for (let x = 0; x < COLS; x++) {
            const idx = colorPalette.indexOf(pixelData[y][x]);
            row.push(idx >= 0 ? idx.toString(16).toUpperCase() : "0");
        }
        out += row.join(", ") + "]\n";
    }
    exportOutput.value = out;

    // 将结果复制到剪贴板
    navigator.clipboard.writeText(out).then(() => {
        showToast('导出的内容已复制到剪贴板');
    }).catch(err => {
        showToast('无法复制到剪贴板: ', err);
    });

}

function importFromText() {
    const text = exportOutput.value.trim();
    if (!text) {
        // 如果输入区域为空，尝试从剪贴板导入
        navigator.clipboard.readText().then(clipboardText => {
            const trimmedText = clipboardText.trim();
            if (trimmedText) {
                try {
                    const lines = trimmedText.split("\n")
                        .map(l => l.trim())
                        .filter(l => l.length !== 0)
                        .map(line => line.replace(/^- +\[/, '').replace(/]$/, ''))
                        .filter(l => l.trim());
                    const newRows = lines.length;
                    const newCols = lines[0].split(",").length;

                    // 计算偏移量，以便在新画布上居中显示图像
                    let offsetX = Math.floor((COLS - newCols) / 2);
                    let offsetY = Math.floor((ROWS - newRows) / 2);

                    // 如果新的尺寸超过了当前画布尺寸，调整偏移量
                    if (newCols > COLS) offsetX = 0;
                    if (newRows > ROWS) offsetY = 0;

                    const imported = [];
                    for (let y = 0; y < ROWS; y++) {
                        const row = [];
                        for (let x = 0; x < COLS; x++) {
                            // 计算对应于原图的位置
                            const srcX = x - offsetX;
                            const srcY = y - offsetY;

                            // 如果超出原图范围，则填充背景色
                            if (srcX < 0 || srcX >= newCols || srcY < 0 || srcY >= newRows) {
                                row.push(colorPalette[0]); // 假设索引0为背景色
                            } else {
                                const v = lines[srcY].split(",")[srcX].trim().toUpperCase();
                                let idx = null;
                                if (/^[0-9A-F]$/.test(v)) idx = parseInt(v, 16); else idx = parseInt(v, 10);
                                if (isNaN(idx) || idx < 0 || idx >= colorPalette.length) throw new Error(`颜色索引无效: ${v}`);
                                row.push(colorPalette[idx]);
                            }
                        }
                        imported.push(row);
                        showToast('成功导入！');
                    }

                    // 更新画布尺寸
                    // document.getElementById("canvasWidth").value = COLS;
                    // document.getElementById("canvasHeight").value = ROWS;
                    pixelData = imported;
                    initCanvas();
                } catch (err) {
                    showToast("导入失败: " + err.message);
                }
            } else {
                showToast("请先粘贴像素画数据");
            }
        }).catch(err => {
            console.error('无法读取剪贴板: ', err);
            showToast("无法读取剪贴板，请手动粘贴数据");
        });
    } else {
        try {
            const lines = text.split("\n")
                .map(l => l.trim())
                .filter(l => l.length !== 0)
                .map(line => line.replace(/^- +\[/, '').replace(/]$/, ''))
                .filter(l => l.trim());
            const newRows = lines.length;
            const newCols = lines[0].split(",").length;

            // 计算偏移量，以便在新画布上居中显示图像
            let offsetX = Math.floor((COLS - newCols) / 2);
            let offsetY = Math.floor((ROWS - newRows) / 2);

            // 如果新的尺寸超过了当前画布尺寸，调整偏移量
            if (newCols > COLS) offsetX = 0;
            if (newRows > ROWS) offsetY = 0;

            const imported = [];
            for (let y = 0; y < ROWS; y++) {
                const row = [];
                for (let x = 0; x < COLS; x++) {
                    // 计算对应于原图的位置
                    const srcX = x - offsetX;
                    const srcY = y - offsetY;

                    // 如果超出原图范围，则填充背景色
                    if (srcX < 0 || srcX >= newCols || srcY < 0 || srcY >= newRows) {
                        row.push(colorPalette[0]); // 假设索引0为背景色
                    } else {
                        const v = lines[srcY].split(",")[srcX].trim().toUpperCase();
                        let idx = null;
                        if (/^[0-9A-F]$/.test(v)) idx = parseInt(v, 16); else idx = parseInt(v, 10);
                        if (isNaN(idx) || idx < 0 || idx >= colorPalette.length) throw new Error(`颜色索引无效: ${v}`);
                        row.push(colorPalette[idx]);
                    }
                }
                imported.push(row);
                showToast('成功导入！');
            }

            pixelData = imported;
            initCanvas();
        } catch (err) {
            showToast("导入失败: " + err.message);
        }
    }
}
/* ====== 导入图片 ====== */

function importImageBtnHandle(rgb){
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => importImageToCanvas(ev.target.result, rgb);
        reader.readAsDataURL(file);
    };
    input.click();
}


// RGB -> HEX, HEX -> RGB
function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
}

// RGB -> Lab
function rgbToLab(r, g, b) {
    [r, g, b] = [r, g, b].map(v => {
        v /= 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });

    const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    const y =  r * 0.2126 + g * 0.7152 + b * 0.0722;// 1.00000;
    const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;

    const f = t => t > 0.008856 ? t ** (1/3) : (7.787 * t) + (16 / 116);
    return [
        (116 * f(y)) - 16,
        500 * (f(x) - f(y)),
        200 * (f(y) - f(z))
    ];
}

// 提前转换整个调色板
const paletteLab = colorPalette.map(hex => {
    const [r,g,b] = hexToRgb(hex);
    return { hex, lab: rgbToLab(r,g,b) };
});

function findNearestLabColor(palette, targetHex) {
    const [r, g, b] = hexToRgb(targetHex);
    const [L1, a1, b1] = rgbToLab(r, g, b);

    let minDist = Infinity;
    let nearest = palette[0].hex;

    for (const { hex, lab } of palette) {
        const [L2, a2, b2] = lab;
        const d = (L1 - L2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2;
        if (d < minDist) {
            minDist = d;
            nearest = hex;
        }
    }

    return nearest;
}

// 查找调色板中最接近的颜色
function findNearestRGBColor(palette, targetHex) {
    const [r1, g1, b1] = hexToRgb(targetHex);
    let minDist = Infinity, nearest = palette[0];
    for (const c of palette) {
        const [r2, g2, b2] = hexToRgb(c);
        const d = (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
        if (d < minDist) {
            minDist = d;
            nearest = c;
        }
    }
    return nearest;
}

async function importImageToCanvas(dataUrl, rgb) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
        // 创建离屏 canvas 缩放图像
        const off = document.createElement("canvas");
        off.width = COLS;
        off.height = ROWS;
        const ctx = off.getContext("2d", {willReadFrequently: true});
        ctx.imageSmoothingEnabled = false;//邻近缩放
        ctx.drawImage(img, 0, 0, off.width, off.height);
        const imgData = ctx.getImageData(0, 0, off.width, off.height).data;

        for (let y = 0; y < ROWS; y++) {
            for (let x = 0; x < COLS; x++) {
                const i = (y * COLS + x) * 4;
                const r = imgData[i];
                const g = imgData[i + 1];
                const b = imgData[i + 2];
                const color = rgbToHex(r, g, b);
                let nearest
                if (rgb) nearest = findNearestRGBColor(colorPalette, color);
                    else nearest = findNearestLabColor(paletteLab, color);
                pixelData[y][x] = nearest;
                const px = canvas.querySelector(`.pixel[data-x="${x}"][data-y="${y}"]`);
                if (px) px.style.backgroundColor = nearest;
            }
        }
    };
    img.src = dataUrl;
}

function exportImageBtnHandle() {
    const scale = 16; // 导出倍率，可改为 4、8 等
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = COLS * scale;
    exportCanvas.height = ROWS * scale;
    const ctx = exportCanvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    // 遍历每个像素绘制放大方块
    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            const color = pixelData[y][x];
            if (!color || color === "transparent" || color === "none") continue;
            ctx.fillStyle = color;
            ctx.fillRect(x * scale, y * scale, scale, scale);
        }
    }

    // 生成下载
    exportCanvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
        a.href = url;
        a.download = `pixel_art_${scale}x_${timestamp}.png`;
        a.click();
        URL.revokeObjectURL(url);
    }, "image/png");
}