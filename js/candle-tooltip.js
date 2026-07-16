/**
 * Candle hover tooltip — shows per-candle stats (OHLC, change, volatility,
 * body/wick ratio, volume vs average) on crosshair hover, and remembers the
 * last hovered candle so the AI can reference the exact candle the user
 * points at ("이 캔들 봐줘").
 *
 * Standalone module: talks to the chart only through window.CryptoCharts
 * (getChartApi) and the 'chart-candles-updated' DOM event — app.js internals
 * are not touched.
 */
(function () {
  'use strict';

  let subscribedChart = null;
  let tooltipEl = null;
  let candles = [];
  let interval = null;
  let lastHovered = null;
  let lastHoveredAt = 0;

  const STYLE = `
.candle-hover-tooltip {
  position: absolute;
  z-index: 40;
  pointer-events: none;
  display: none;
  min-width: 190px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(19, 23, 34, 0.94);
  border: 1px solid #2a2e39;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  font-size: 11px;
  line-height: 1.55;
  color: #d1d4dc;
  font-family: inherit;
}
.candle-hover-tooltip__time {
  color: #8b93a6;
  margin-bottom: 4px;
  font-size: 10px;
}
.candle-hover-tooltip table { border-collapse: collapse; width: 100%; }
.candle-hover-tooltip td { padding: 0 0 1px; }
.candle-hover-tooltip td:first-child { color: #8b93a6; padding-right: 10px; white-space: nowrap; }
.candle-hover-tooltip td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
.candle-hover-tooltip .up { color: #0ecb81; }
.candle-hover-tooltip .down { color: #f6465d; }
`;

  function injectStyle() {
    if (document.getElementById('candleTooltipStyle')) return;
    const style = document.createElement('style');
    style.id = 'candleTooltipStyle';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function fmtPrice(v) {
    if (!Number.isFinite(v)) return '—';
    if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
    if (v >= 1) return v.toFixed(2);
    return v.toPrecision(4);
  }

  function fmtVol(v) {
    if (!Number.isFinite(v)) return '—';
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return v.toFixed(1);
  }

  function fmtTime(unixSec) {
    const d = new Date(unixSec * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Computes hover metrics for the candle at index i.
  function candleMetrics(i) {
    const c = candles[i];
    if (!c) return null;
    const prev = candles[i - 1] || null;
    const range = c.high - c.low;
    const body = c.close - c.open;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const volWindow = candles.slice(Math.max(0, i - 20), i);
    const avgVol = volWindow.length
      ? volWindow.reduce((s, x) => s + (x.volume || 0), 0) / volWindow.length
      : null;

    return {
      time: c.time,
      timeText: fmtTime(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? null,
      dir: body >= 0 ? 'up' : 'down',
      changePct: c.open ? (body / c.open) * 100 : 0,
      rangePct: c.open ? (range / c.open) * 100 : 0,
      bodyPct: range > 0 ? (Math.abs(body) / range) * 100 : 0,
      upperWickPct: range > 0 ? (upperWick / range) * 100 : 0,
      lowerWickPct: range > 0 ? (lowerWick / range) * 100 : 0,
      vsPrevClosePct: prev && prev.close ? ((c.close - prev.close) / prev.close) * 100 : null,
      volumeVsAvg20: avgVol > 0 && c.volume != null ? c.volume / avgVol : null,
      barsAgo: candles.length - 1 - i,
    };
  }

  function signed(v, digits = 2) {
    if (!Number.isFinite(v)) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
  }

  function renderTooltip(m) {
    const cls = m.dir;
    const rows = [
      ['시가 O', fmtPrice(m.open), ''],
      ['고가 H', fmtPrice(m.high), ''],
      ['저가 L', fmtPrice(m.low), ''],
      ['종가 C', fmtPrice(m.close), cls],
      ['등락', signed(m.changePct), cls],
      ['전봉 대비', m.vsPrevClosePct != null ? signed(m.vsPrevClosePct) : '—', m.vsPrevClosePct >= 0 ? 'up' : 'down'],
      ['변동폭', `${m.rangePct.toFixed(2)}%`, ''],
      ['몸통 비율', `${m.bodyPct.toFixed(0)}%`, ''],
      ['꼬리 위/아래', `${m.upperWickPct.toFixed(0)}% / ${m.lowerWickPct.toFixed(0)}%`, ''],
      ['거래량', fmtVol(m.volume), ''],
      ['거래량/20봉평균', m.volumeVsAvg20 != null ? `${m.volumeVsAvg20.toFixed(2)}x` : '—', m.volumeVsAvg20 >= 1.5 ? 'up' : ''],
    ];
    const table = rows
      .map(([k, v, c]) => `<tr><td>${k}</td><td class="${c}">${v}</td></tr>`)
      .join('');
    tooltipEl.innerHTML = `<div class="candle-hover-tooltip__time">${m.timeText}${m.barsAgo ? ` · ${m.barsAgo}봉 전` : ' · 현재봉'}</div><table>${table}</table>`;
  }

  function ensureTooltipEl(container) {
    if (tooltipEl && tooltipEl.parentElement === container) return tooltipEl;
    if (tooltipEl) tooltipEl.remove();
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'candle-hover-tooltip';
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(tooltipEl);
    return tooltipEl;
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  function onCrosshairMove(param) {
    if (!tooltipEl) return;
    if (!param || !param.time || !param.point) {
      hideTooltip();
      return;
    }
    const idx = candles.findIndex((c) => c.time === param.time);
    if (idx < 0) {
      hideTooltip();
      return;
    }
    const m = candleMetrics(idx);
    if (!m) {
      hideTooltip();
      return;
    }
    lastHovered = m;
    lastHoveredAt = Date.now();
    renderTooltip(m);

    const container = tooltipEl.parentElement;
    tooltipEl.style.display = 'block';
    const pad = 14;
    const tw = tooltipEl.offsetWidth;
    const th = tooltipEl.offsetHeight;
    const cw = container.clientWidth;
    const chh = container.clientHeight;
    let x = param.point.x + pad;
    let y = param.point.y + pad;
    if (x + tw > cw - 4) x = param.point.x - tw - pad;
    if (y + th > chh - 4) y = Math.max(4, param.point.y - th - pad);
    tooltipEl.style.left = `${Math.max(4, x)}px`;
    tooltipEl.style.top = `${y}px`;
  }

  function trySubscribe() {
    const api = window.CryptoCharts?.getChartApi?.();
    const chart = api?.chart;
    if (!chart) return;
    const container = document.getElementById('chartArea')?.parentElement
      || document.querySelector('.chart-main');
    if (!container) return;
    ensureTooltipEl(container);
    if (chart === subscribedChart) return;
    subscribedChart = chart;
    chart.subscribeCrosshairMove(onCrosshairMove);
  }

  document.addEventListener('chart-candles-updated', (e) => {
    candles = e.detail?.candles || window.CryptoCharts?.getCandles?.() || [];
    interval = e.detail?.interval || null;
    trySubscribe();
  });
  document.addEventListener('chart-candle-tick', (e) => {
    if (Array.isArray(e.detail?.candles)) candles = e.detail.candles;
  });

  injectStyle();

  window.CandleTooltip = {
    // Last candle the user pointed at, for the AI market context.
    getLastHovered() {
      if (!lastHovered) return null;
      return {
        ...lastHovered,
        interval,
        hoveredAgoSec: Math.round((Date.now() - lastHoveredAt) / 1000),
      };
    },
  };
})();
