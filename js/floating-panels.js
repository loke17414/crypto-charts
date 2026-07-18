/* Chart panel — fills the trading canvas; AI is a separate toggle popup. */

const FloatingPanels = (() => {
  const STORAGE_KEY = 'crypto-charts-float-panels-v4';

  function notifyChartResize() {
    window.dispatchEvent(new Event('resize'));
    if (typeof IndicatorManager !== 'undefined') IndicatorManager.onResize();
  }

  function applyChartFit(panel, canvas) {
    panel.style.left = '0';
    panel.style.top = '0';
    panel.style.width = `${canvas.clientWidth}px`;
    panel.style.height = `${canvas.clientHeight}px`;
    notifyChartResize();
  }

  function init() {
    if (!document.body.classList.contains('trading-page--simple')) return;

    const canvas = document.getElementById('floatPanelCanvas');
    const panel = canvas?.querySelector('[data-panel-id="chart"]');
    if (!canvas || !panel) return;

    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }

    const boot = () => {
      if (canvas.clientWidth < 80 || canvas.clientHeight < 120) {
        requestAnimationFrame(boot);
        return;
      }
      applyChartFit(panel, canvas);

      let resizeTimer = null;
      const ro = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => applyChartFit(panel, canvas), 80);
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
