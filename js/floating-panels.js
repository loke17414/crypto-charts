/* Draggable / resizable floating panels on the trading page */

const FloatingPanels = (() => {
  const STORAGE_KEY = 'crypto-charts-float-panels-v2';
  const MIN_W = 280;
  const MIN_H = 140;

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

  function defaultLayout(canvas) {
    const pad = 6;
    const cw = canvas.clientWidth || 640;
    const ch = canvas.clientHeight || 480;
    const aiW = Math.min(380, Math.max(300, Math.round(cw * 0.36)));
    const aiH = Math.min(440, Math.max(260, Math.round(ch * 0.4)));
    return {
      chart: { x: pad, y: pad, w: Math.max(MIN_W, cw - pad * 2), h: Math.max(MIN_H, ch - pad * 2) },
      ai: {
        x: Math.max(pad, cw - aiW - pad),
        y: Math.max(pad, ch - aiH - pad),
        w: aiW,
        h: aiH,
      },
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

  function initPanel(panel, canvas, state, id) {
    const handle = panel.querySelector('[data-drag-handle]');
    const resize = panel.querySelector('[data-resize-handle]');
    if (!handle || !resize) return;

    const rect = clampRect(state[id] || defaultLayout(canvas)[id], canvas);
    applyRect(panel, rect);
    state[id] = rect;

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
      const defaults = defaultLayout(canvas);
      const next = clampRect(defaults[id], canvas);
      applyRect(panel, next);
      state[id] = next;
      saveState(state);
      notifyChartResize();
    });
  }

  function relayout(canvas, panels, state) {
    const defaults = defaultLayout(canvas);
    panels.forEach((panel) => {
      const id = panel.dataset.panelId;
      if (!id) return;
      if (!state[id]) state[id] = defaults[id];
      state[id] = clampRect(state[id], canvas);
      applyRect(panel, state[id]);
    });
    saveState(state);
    notifyChartResize();
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
      if (!state.chart || !state.ai) {
        Object.assign(state, defaultLayout(canvas));
      }
      panels.forEach((panel) => initPanel(panel, canvas, state, panel.dataset.panelId));
      saveState(state);

      let resizeTimer = null;
      const ro = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          panels.forEach((panel) => {
            const id = panel.dataset.panelId;
            if (!id || !state[id]) return;
            state[id] = clampRect(state[id], canvas);
            applyRect(panel, state[id]);
          });
          saveState(state);
          notifyChartResize();
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
