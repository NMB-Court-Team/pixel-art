// ⚙️ 移动设备检测
if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    alert("移动设备访问有部分工具会无法使用，推荐使用桌面浏览器以获得完整体验");
}

/* ====== 事件处理 ====== */
function setupEventListeners() {
    // 恢复：关闭/刷新前提示（原版）
    window.addEventListener("beforeunload", (e) => {
        e.preventDefault();
        e.returnValue = "⚠️ 数据将不会保存, 确定退出吗？";
    });

    // 在页面隐藏/卸载时保存画布
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) saveCanvasToLocal();
    });
    window.addEventListener('pagehide', saveCanvasToLocal);
    // 兼容性：在 beforeunload 也保存（setupEventListeners 中会提示是否离开）
    window.addEventListener('beforeunload', saveCanvasToLocal);

    function activateToolButton(btnId, toolName) {
        const btn = document.getElementById(btnId);
        btn.addEventListener("click", () => {
            tool = toolName;
            document.querySelectorAll(".btn-group button").forEach(b => b.classList.remove("active"));
            refreshSymmetry()
            btn.classList.add("active");
            previewLayer.innerHTML = "";
            startX = startY = null;
            isDrawing = false;
        });
    }

    activateToolButton("pen", "pen");
    activateToolButton("eraser", "eraser");
    activateToolButton("line", "line");
    activateToolButton("rect", "rect");
    activateToolButton("circle", "circle");
    activateToolButton("fill", "fill");
    activateToolButton("eyedropper", "eyedropper");

    // 选区按钮（+ hover 提示）
    document.getElementById('selRect').addEventListener('click', () => {
        selectionMode = 'rect';
        selectionPixels.clear();
        selectionBounds = null;
        setActiveSelection('selRect');
        renderSelectionLayer();
    });

    document.getElementById('selFree').addEventListener('click', () => {
        selectionMode = 'free';
        selectionPixels.clear();
        selectionBounds = null;
        setActiveSelection('selFree');
        renderSelectionLayer();
    });
    document.getElementById('selMove').addEventListener('click', () => {
        if (!selectionBounds) return alert('先选区再移动');
        beginMove();
    });
    document.getElementById('selCopy').addEventListener('click', () => {
        copySelection();
    });
    document.getElementById('selCut').addEventListener('click', () => {
        cutSelection();
    });
    document.getElementById('selPaste').addEventListener('click', () => {
        beginPaste();
    });
    document.getElementById('selClear').addEventListener('click', () => {
        clearSelection();
    });
    document.getElementById('selPlace').addEventListener('click', () => {
        applyPaste();
    });

    // 撤回/重做/清空/导出/导入/添加颜色/resize
    document.getElementById("undo").addEventListener("click", undo);
    document.getElementById("redo").addEventListener("click", redo);
    document.getElementById("clear").addEventListener("click", () => {
        if (!confirm("确定要清空画布吗？")) return;
        initData();
        initCanvas();
    });
    document.getElementById("toggleGrid").addEventListener("click", () => {
        const wrapper = document.getElementById("canvasWrapper");
        wrapper.classList.toggle("no-grid");
    });
    document.getElementById("exportBtn").addEventListener("click", exportAsText);
    document.getElementById("importBtn").addEventListener("click", importFromText);
    window.addEventListener("resize", resizeWrapper);
    // ======= 导入图片 ======

    document.getElementById("importImage").addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => importImageToCanvas(ev.target.result);
            reader.readAsDataURL(file);
        };
        input.click();
    });

    // symmetry
    document.querySelectorAll(".symmetry-btn").forEach(btn => {
        btn.addEventListener("click", function () {
            document.querySelectorAll(".symmetry-btn").forEach(b => b.classList.remove("active"));
            this.classList.add("active");
            symmetryMode = this.dataset.mode;
        });
    });
    document.querySelector('.symmetry-btn[data-mode="none"]').classList.add("active");

    // 添加触摸事件监听
    canvas.addEventListener('touchstart', handleTouchStart, {passive: false});
    canvas.addEventListener('touchmove', handleTouchMove, {passive: false});
    canvas.addEventListener('touchend', handleTouchEnd, {passive: false});
    canvas.addEventListener('touchcancel', handleTouchEnd, {passive: false});

    canvas.addEventListener("mousedown", (e) => handleMouseDown(e));
    canvas.addEventListener("mousemove", (e) => handleMouseMove(e));
    document.addEventListener("mouseup", (e) => handleMouseUp(e));

    // 键盘：Enter 确认粘贴/移动；Esc 清除；Ctrl 快捷键（但如果焦点在输入框/文本域/可编辑元素中则放行原生）
    document.addEventListener('keydown', (e) => handleKeyDown(e));

    document.addEventListener('keyup', (e) => handleKeyUp(e));

    // 🧭 防止 Alt+Tab 后卡在取色模式
    window.addEventListener("blur", () => {
        // 当窗口失焦时标记状态
        if (isColorPicking) {
            window._wasColorPicking = true;
        }
    });

    window.addEventListener("focus", () => {
        // 如果失焦时正在取色, 则强制恢复原工具
        if (window._wasColorPicking) {
            window._wasColorPicking = false;
            isColorPicking = false;
            setActiveTool(previousTool || "pen");
            previousTool = null;
        }
    });

    // 防拖拽
    canvas.addEventListener("dragstart", (e) => {
        e.preventDefault();
        return false;
    });

    // 切换主题的函数
    function toggleTheme() {
        const body = document.body;
        body.classList.toggle('dark-theme');
    }

    // 添加事件监听器到主题切换按钮
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);

    // 切换使用说明的显示与隐藏
    function toggleHelpSection() {
        const helpSection = document.getElementById('helpSection');
        if (helpSection.style.display === 'none' || helpSection.style.display === '') {
            helpSection.style.display = 'block';
            document.getElementById('toggleHelp').textContent = '隐藏使用说明';
            helpSection.scrollIntoView({ behavior: 'smooth' });
        } else {
            helpSection.style.display = 'none';
            document.getElementById('toggleHelp').textContent = '显示使用说明';
        }
    }

    // 添加事件监听器到使用说明切换按钮
    document.getElementById('toggleHelp').addEventListener('click', toggleHelpSection);
}

/* ====== 初始化入口 ====== */
(function initAll() {
    initData();
    renderColorPalette();
    initRemapPanel();
    initCanvas();
    loadCanvasFromLocal();
    setupEventListeners();
    preloadAudio();
})();