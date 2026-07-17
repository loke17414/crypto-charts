/* Draggable / resizable floating panels on the trading page */

const FloatingPanels = (() => {
  const STORAGE_KEY = 'crypto-charts-float-panels-v3';
  const MIN_W = 280;
  const MIN_H = 140;
  const AI_MIN_W = 280;
  const AI_MAX_W = 400;
  const AI_WIDTH_RATIO = 0.30;
  const PANEL_GAP = 3;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch { /* ignore */ }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function notifyChartResize() {
    window.dispatchEvent(new Event('resize'));
    if (typeof IndicatorManager !== 'undefined') IndicatorManager.onResize();
  }

  function applyRect(panel, rect) {
    panel.style.left = `${rect.x}px`;
    panel.style.top = `${rect.y}px`;
    panel.style.width = `${rect.w}px`;
    panel.style.height = `${rect.h}px`;
  }

  /** Side-by-side dock: chart fills left, AI fills right — both full canvas height. */
  function fitLayout(canvas) {
    const cw = canvas.clientWidth || 640;
    const ch = canvas.clientHeight || 480;
    const aiW = clamp(Math.round(cw * AI_WIDTH_RATIO), AI_MIN_W, AI_MAX_W);
    const chartW = Math.max(MIN_W, cw - aiW - PANEL_GAP);
    const h = Math.max(MIN_H, ch);
    return {
      chart: { x: 0, y: 0, w: chartW, h },
      ai: { x: chartW + PANEL_GAP, y: 0, w: aiW, h },
    };
  }

  function clampRect(rect, canvas) {
    const maxW = Math.max(MIN_W, canvas.clientWidth - 8);
    const maxH = Math.max(MIN_H, canvas.clientHeight - 8);
    const w = clamp(rect.w, MIN_W, maxW);
    const h = clamp(rect.h, MIN_H, maxH);
    const x = clamp(rect.x, 0, Math.max(0, canvas.clientWidth - w));
    const y = clamp(rect.y, 0, Math.max(0, canvas.clientHeight - h));
    return { x, y, w, h };
  }

  function applyFitLayout(canvas, panels, state) {
    const layout = fitLayout(canvas);
    panels.forEach((panel) => {
      const id = panel.dataset.panelId;
      if (!id || !layout[id]) return;
      state[id] = layout[id];
      applyRect(panel, state[id]);
    });
    saveState(state);
    notifyChartResize();
  }

  function initPanel(panel, canvas, state, id) {
    const handle = panel.querySelector('[data-drag-handle]');
    const resize = panel.querySelector('[data-resize-handle]');
    if (!handle || !resize) return;

    let drag = null;
    let resizeDrag = null;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, select, textarea, a, label, .strategy-ai-status')) return;
      e.preventDefault();
      panel.classList.add('is-dragging');
      panel.setPointerCapture(e.pointerId);
      drag = {
        startX: e.clientX,
        startY: e.clientY,
        orig: { ...state[id] },
      };
    });

    resize.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      panel.classList.add('is-resizing');
      panel.setPointerCapture(e.pointerId);
      resizeDrag = {
        startX: e.clientX,
        startY: e.clientY,
        orig: { ...state[id] },
      };
    });

    panel.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        const next = clampRect({
          x: drag.orig.x + dx,
          y: drag.orig.y + dy,
          w: drag.orig.w,
          h: drag.orig.h,
        }, canvas);
        applyRect(panel, next);
        state[id] = next;
      } else if (resizeDrag) {
        const dx = e.clientX - resizeDrag.startX;
        const dy = e.clientY - resizeDrag.startY;
        const next = clampRect({
          x: resizeDrag.orig.x,
          y: resizeDrag.orig.y,
          w: resizeDrag.orig.w + dx,
          h: resizeDrag.orig.h + dy,
        }, canvas);
        applyRect(panel, next);
        state[id] = next;
        notifyChartResize();
      }
    });

    const endInteraction = (e) => {
      if (!drag && !resizeDrag) return;
      drag = null;
      resizeDrag = null;
      panel.classList.remove('is-dragging', 'is-resizing');
      try { panel.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      saveState(state);
      notifyChartResize();
    };

    panel.addEventListener('pointerup', endInteraction);
    panel.addEventListener('pointercancel', endInteraction);

    handle.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, select, textarea, a')) return;
      const panels = [...canvas.querySelectorAll('[data-panel-id]')];
      applyFitLayout(canvas, panels, state);
    });
  }

  function init() {
    if (!document.body.classList.contains('trading-page--simple')) return;

    const canvas = document.getElementById('floatPanelCanvas');
    if (!canvas) return;

    const panels = [...canvas.querySelectorAll('[data-panel-id]')];
    if (!panels.length) return;

    const state = loadState();

    const boot = () => {
      if (canvas.clientWidth < 80 || canvas.clientHeight < 120) {
        requestAnimationFrame(boot);
        return;
      }
      applyFitLayout(canvas, panels, state);
      panels.forEach((panel) => initPanel(panel, canvas, state, panel.dataset.panelId));

      let resizeTimer = null;
      const ro = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          applyFitLayout(canvas, panels, state);
        }, 80);
      });
      ro.observe(canvas);

      setTimeout(notifyChartResize, 120);
      setTimeout(notifyChartResize, 500);
    };

    boot();
  }

  return { init };
})();

window.FloatingPanels = FloatingPanels;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => FloatingPanels.init());
} else {
  FloatingPanels.init();
}
