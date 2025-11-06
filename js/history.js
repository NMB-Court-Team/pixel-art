const MAX_HISTORY = 500;
let historyStack = [];        // 历史
let redoStack = [];

/* ====== 历史（撤回/重做） ====== */
function pushHistory(step) {
    if (!step || step.length === 0) return;
    historyStack.push(step);
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
    redoStack = [];
}

function undo() {
    const step = historyStack.pop();
    if (!step) return;
    step.forEach(p => setPixelDirect(p.x, p.y, p.oldColor));
    redoStack.push(step);
}

function redo() {
    const step = redoStack.pop();
    if (!step) return;
    step.forEach(p => setPixelDirect(p.x, p.y, p.newColor));
    historyStack.push(step);
}
/* ====== 本地自动保存/恢复（localStorage） ====== */
const _LOCAL_KEY = 'pixelEditor:state:v1';

function saveCanvasToLocal() {
    try {
        const state = {
            pixelData,
            currentMapping,
            currentColor,
            symmetryMode
        };
        localStorage.setItem(_LOCAL_KEY, JSON.stringify(state));
    } catch (err) {
        console.warn('保存本地缓存失败', err);
    }
}

function loadCanvasFromLocal() {
    try {
        const raw = localStorage.getItem(_LOCAL_KEY);
        if (!raw) return false;
        const s = JSON.parse(raw);
        if (Array.isArray(s.currentMapping) && s.currentMapping.length === basePalette.length) {
            currentMapping = s.currentMapping.slice();
        } else {
            currentMapping = basePalette.slice();
        }
        if (Array.isArray(s.pixelData) && s.pixelData.length === ROWS) {
            // clone rows safely
            pixelData = s.pixelData.map(row => Array.isArray(row) ? row.slice() : Array.from({length: COLS}, () => colorPalette[0]));
        }
        if (s.currentColor) currentColor = s.currentColor;
        if (s.symmetryMode) symmetryMode = s.symmetryMode;

        // 重新渲染 UI
        renderColorPalette();
        initRemapPanel();
        if (typeof refreshRemapGrid === 'function') refreshRemapGrid();
        initCanvas();
        if (typeof refreshSymmetry === 'function') refreshSymmetry();

        // showToast('已从本地恢复上次画布');
        return true;
    } catch (err) {
        console.warn('恢复本地缓存失败', err);
        return false;
    }
}