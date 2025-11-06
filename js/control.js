/* ====== 全局状态 ====== */
let currentMousePos = {x: 0, y: 0};
let pendingMousePos = null;
let rafId = null;
let isColorPicking = false;
let previousTool = null;   // 用来临时记住上一个工具
let dragStart = null;
let isDrawing = false;
let startX = null, startY = null;
let lastDrawX = null, lastDrawY = null; // 记录上一次绘制的位置

/* ====== DOM 缓存 ====== */
const dom = {
    canvas: document.getElementById("canvas"),
    wrapper: document.getElementById("canvasWrapper"),
    preview: document.getElementById("previewLayer"),
    gridToggle: document.getElementById("toggleGrid"),
    selRectBtn: document.getElementById("selRect"),

    btnGroups: document.querySelectorAll(".btn-group button"),
    symmetryBtns: document.querySelectorAll(".symmetry-btn"),
    colorPalette: document.getElementById("colorPalette")
};

/* ====== 辅助函数 ====== */
function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function selectColor(color) {
    currentColor = color;
    console.info(currentColor)
    let colorBtns = colorPaletteContainer.querySelectorAll(".color-btn");
    colorBtns.forEach(x => x.classList.remove("selected"));
    console.info(colorBtns)
    const idx = colorPalette.indexOf(color);
    console.info(idx)
    if (idx >= 0 && colorBtns[idx]) {
        colorBtns[idx].classList.add("selected");
    }
}

/* 批量像素 DOM 更新队列 */
const pixelsToRender = new Set();

function queuePixelUpdate(x, y, color) {
    pixelsToRender.add(`${x},${y},${color}`);
}

function renderPendingPixels() {
    if (!pixelsToRender.size) return;
    const updates = [...pixelsToRender];
    pixelsToRender.clear();
    for (const entry of updates) {
        const [x, y, color] = entry.split(",");
        const el = dom.canvas.querySelector(`.pixel[data-x="${x}"][data-y="${y}"]`);
        if (el) el.style.backgroundColor = color;
    }
}

setInterval(renderPendingPixels, 16);

/* ====== 绘图辅助 ====== */
function drawInterpolatedLine(x1, y1, x2, y2, color = currentColor) {
    const points = getLinePixels(x1, y1, x2, y2);
    for (const p of points) {
        const pts = getSymmetryPoints(p.x, p.y);
        for (const pt of pts) {
            if (pixelData[pt.y][pt.x] !== color) {
                const oldColor = pixelData[pt.y][pt.x];
                pixelData[pt.y][pt.x] = color;
                queuePixelUpdate(pt.x, pt.y, color);
                if (currentStep) currentStep.push({x: pt.x, y: pt.y, oldColor, newColor: color});
            }
        }
    }
    lastDrawX = x2;
    lastDrawY = y2;
}

function finalizeDrawing() {
    isDrawing = false;
    lastDrawX = lastDrawY = null;
    if (canvas._curStep && canvas._curStep.length > 0) {
        pushHistory(canvas._curStep);
    }
    canvas._curStep = currentStep = null;
}

/* ====== 工具逻辑定义 ====== */
const toolHandlers = {
    pen: {
        down(pos) {
            isDrawing = true;
            currentStep = [];
            drawPixel(pos.x, pos.y);
            lastDrawX = pos.x;
            lastDrawY = pos.y;
            canvas._curStep = currentStep;
        },
        move(pos) {
            if (lastDrawX !== null) drawInterpolatedLine(lastDrawX, lastDrawY, pos.x, pos.y);
            else {
                drawPixel(pos.x, pos.y);
                lastDrawX = pos.x;
                lastDrawY = pos.y;
            }
        },
        up: finalizeDrawing
    },

    eraser: {
        down(pos) {
            isDrawing = true;
            currentStep = [];
            drawPixel(pos.x, pos.y, colorPalette[0]);
            lastDrawX = pos.x;
            lastDrawY = pos.y;
            canvas._curStep = currentStep;
        },
        move(pos) {
            if (lastDrawX !== null)
                drawInterpolatedLine(lastDrawX, lastDrawY, pos.x, pos.y, colorPalette[0]);
            else {
                drawPixel(pos.x, pos.y, colorPalette[0]);
                lastDrawX = pos.x;
                lastDrawY = pos.y;
            }

        },
        up: finalizeDrawing
    },

    eyedropper: {
        down(pos) {
            const picked = pixelData[pos.y][pos.x];
            if (picked) selectColor(picked);
            dom.preview.innerHTML = "";
        }
    },

    fill: {
        down(pos) {
            const target = pixelData[pos.y][pos.x];
            if (target !== currentColor) floodFill(pos.x, pos.y, target, currentColor, false);
            dom.preview.innerHTML = "";
        }
    }
};

/* ====== 鼠标事件 ====== */
function handleMouseDown(e) {
    if (e.button !== 0) return;
    const pos = getPixelFromEvent(e);
    if (!pos) return;

    // 选区逻辑
    if (selectionMode === "rect" || selectionMode === "free") {
        isSelecting = true;
        dragStart = pos;
        if (selectionMode === "free") {
            lastToggledKey = `${pos.x},${pos.y}`;
            toggleSelectionPixel(pos.x, pos.y);
        }
        return;
    }

    if ((selectionMode === "paste" || selectionMode === "move") && clipboard) {
        isDraggingPaste = true;
        dragStart = pos;
        return;
    }

    // 工具逻辑
    const handler = toolHandlers[tool];
    if (handler?.down) return handler.down(pos);

    // 图形起点
    if (["line", "rect", "circle"].includes(tool)) {
        startX = pos.x;
        startY = pos.y;
    }
}

/* ====== 鼠标坐标映射 ====== */
function getPixelFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / PIXEL_SIZE);
    const y = Math.floor((e.clientY - rect.top) / PIXEL_SIZE);
    if (x >= 0 && x < COLS && y >= 0 && y < ROWS) return {x, y};
    return null;
}

function handleMouseMove(e) {
    const pos = getPixelFromEvent(e);
    if (!pos) return;
    pendingMousePos = {x: pos.x, y: pos.y, shiftKey: e.shiftKey};
    if (!rafId) rafId = requestAnimationFrame(processMouseMove);
}

function processMouseMove() {
    rafId = null;
    if (!pendingMousePos) return;
    const {x, y, shiftKey} = pendingMousePos;
    pendingMousePos = null;
    currentMousePos = {x, y};

    // 选区矩形
    if (isSelecting && selectionMode === "rect" && dragStart) {
        setSelectionFromRect(dragStart.x, dragStart.y, x, y, shiftKey);
        return;
    }
    // 手涂选区
    if (isSelecting && selectionMode === "free") {
        const key = `${x},${y}`;
        if (key !== lastToggledKey) {
            toggleSelectionPixel(x, y);
            lastToggledKey = key;
        }
        return;
    }
    // 粘贴拖动
    if (isDraggingPaste && clipboard) {
        const dx = x - dragStart.x, dy = y - dragStart.y;
        pasteOffset.x = clamp(pasteOffset.x + dx, -clipboard.w, COLS);
        pasteOffset.y = clamp(pasteOffset.y + dy, -clipboard.h, ROWS);
        dragStart = {x, y};
        renderSelectionLayer();
        return;
    }
    // 绘图拖动
    if (isDrawing && toolHandlers[tool]?.move) {
        toolHandlers[tool].move({x, y});
        return;
    }
    // 图形预览
    if (startX !== null && startY !== null) {
        const hollow = shiftKey;
        let pixels = [];
        if (tool === "line") pixels = getLinePixels(startX, startY, x, y);
        else if (tool === "rect") pixels = getRectPixels(startX, startY, x, y, hollow);
        else if (tool === "circle") {
            const r = Math.round(Math.hypot(x - startX, y - startY));
            pixels = getCirclePixels(startX, startY, r, hollow);
        }
        renderPreview(pixels);
    }
}

function handleMouseUp(e) {
    const pos = getPixelFromEvent(e);

    if (isSelecting) {
        isSelecting = false;
        dragStart = lastToggledKey = null;
        return;
    }
    if (isDraggingPaste) {
        isDraggingPaste = false;
        dragStart = null;
        return;
    }

    if (isDrawing && toolHandlers[tool]?.up) {
        toolHandlers[tool].up(pos);
        return;
    }

    // 图形提交
    if (startX !== null && startY !== null && pos) {
        const hollow = e.shiftKey;
        currentStep = [];
        let pts = [];
        if (tool === "line") pts = getLinePixels(startX, startY, pos.x, pos.y);
        else if (tool === "rect") pts = getRectPixels(startX, startY, pos.x, pos.y, hollow);
        else if (tool === "circle") {
            const r = Math.round(Math.hypot(pos.x - startX, pos.y - startY));
            pts = getCirclePixels(startX, startY, r, hollow);
        }
        pts.forEach(p => drawPixel(p.x, p.y, null));
        if (currentStep.length) pushHistory(currentStep);
        currentStep = null;
    }

    startX = startY = null;
    dom.preview.innerHTML = "";
}

/* ====== 键盘事件 ====== */
const switchtools = {
    b: () => setActiveTool("pen"),
    e: () => setActiveTool("eraser"),
    f: () => setActiveTool("fill"),
    m: () => dom.selRectBtn?.click(),
    g: () => dom.gridToggle?.click()
}
const shortcuts = {
    z: () => undo(),
    y: () => redo(),
    c: () => copySelection(),
    x: () => cutSelection(),
    v: () => beginPaste()
};

function handleKeyDown(e) {
    const tag = document.activeElement?.tagName?.toLowerCase() || "";
    const inInput = tag === "input" || tag === "textarea" || document.activeElement?.isContentEditable;
    if (inInput) return;



    if (e.key === "Enter" && clipboard) {
        if (selectionMode === "paste" || selectionMode === "move") applyPaste();
    }
    if (e.key === "Escape") {
        clearSelection();
        dom.preview.innerHTML = "";
    }
    const tool = switchtools[e.key.toLowerCase()];
    if (tool) {
        e.preventDefault();
        tool();
    }
    if ((e.key === 'c' || e.key === 'x') && e.ctrlKey && !selectionBounds) return
    if (e.key === 'v' && e.ctrlKey && !clipboard) return
    if (e.ctrlKey || e.metaKey) {
        const fn = shortcuts[e.key.toLowerCase()];
        if (fn) {
            e.preventDefault();
            fn();
        }
    }

    if ((e.key === "Alt" || e.code.startsWith("Alt")) && !isColorPicking) {
        e.preventDefault();
        isColorPicking = true;
        previousTool = tool;
        setActiveTool("eyedropper");
    }
}

function handleKeyUp(e) {
    if ((e.key === "Alt" || e.code.startsWith("Alt")) && isColorPicking) {
        isColorPicking = false;
        setActiveTool(previousTool || "pen");
        previousTool = null;
    }
}

/* ====== 触摸事件映射 ====== */
function handleTouchStart(e) {
    e.preventDefault();
    const t = e.touches[0];
    dom.canvas.dispatchEvent(new MouseEvent("mousedown", {clientX: t.clientX, clientY: t.clientY, button: 0}));
}

function handleTouchMove(e) {
    e.preventDefault();
    const t = e.touches[0];
    dom.canvas.dispatchEvent(new MouseEvent("mousemove", {clientX: t.clientX, clientY: t.clientY}));
}

function handleTouchEnd(e) {
    e.preventDefault();
    document.dispatchEvent(new MouseEvent("mouseup", {button: 0}));
}
