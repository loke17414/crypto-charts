/* Price-level + backtest marker overlay on top of the TradingView iframe.
 * TV's free widget cannot receive drawings, so we map Orbinex candles → SVG. */
(function () {
  const VISIBLE_BARS = 140;
  const PAD_PCT = 0.04;

  let root = null;
  let svg = null;
  let labelsEl = null;
  let markersEl = null;
  let active = false;
  let wrapped = false;

  let position = null;
  let signal = null;
  let markers = [];
  let backtestTrades = [];
  let resizeObs = null;

  function $(id) {
    return document.getElementById(id);
  }

  function fmt(price) {
    if (!Number.isFinite(price)) return '—';
    if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (price >= 1) return price.toLocaleString('en-US', { maximumFractionDigits: 4 });
    return price.toLocaleString('en-US', { maximumFractionDigits: 6 });
  }

  function ensureDom() {
    const plot = document.querySelector('.chart-main__plot');
    if (!plot) return false;
    root = $('tvLevelsOverlay');
    if (!root) {
      root = document.createElement('div');
      root.id = 'tvLevelsOverlay';
      root.className = 'tv-levels-overlay';
      root.innerHTML = [
        '<svg class="tv-levels-overlay__svg" aria-hidden="true"></svg>',
        '<div class="tv-levels-overlay__markers" aria-hidden="true"></div>',
        '<div class="tv-levels-overlay__labels"></div>',
      ].join('');
      plot.appendChild(root);
    }
    svg = root.querySelector('.tv-levels-overlay__svg');
    markersEl = root.querySelector('.tv-levels-overlay__markers');
    labelsEl = root.querySelector('.tv-levels-overlay__labels');
    return true;
  }

  function setActive(on) {
    active = Boolean(on);
    if (!ensureDom()) return;
    root.classList.toggle('is-active', active);
    root.setAttribute('aria-hidden', active ? 'false' : 'true');
    if (active) {
      render();
      if (!resizeObs && typeof ResizeObserver !== 'undefined') {
        resizeObs = new ResizeObserver(() => render());
        resizeObs.observe(root);
      }
    }
  }

  function candles() {
    const list = window.CryptoCharts?.getCandles?.() || [];
    return Array.isArray(list) ? list : [];
  }

  function buildScale(all) {
    if (!root || !all.length) return null;
    const w = root.clientWidth || 0;
    const h = root.clientHeight || 0;
    if (w < 40 || h < 40) return null;

    const slice = all.length > VISIBLE_BARS ? all.slice(-VISIBLE_BARS) : all.slice();
    let minP = Infinity;
    let maxP = -Infinity;
    for (const c of slice) {
      if (Number.isFinite(c.low)) minP = Math.min(minP, c.low);
      if (Number.isFinite(c.high)) maxP = Math.max(maxP, c.high);
    }
    const levels = [];
    for (const src of [position, signal]) {
      if (!src) continue;
      for (const k of ['entryPrice', 'stopPrice', 'takeProfitPrice']) {
        if (Number.isFinite(src[k])) levels.push(src[k]);
      }
    }
    for (const m of markers) {
      if (Number.isFinite(m.price)) levels.push(m.price);
    }
    for (const t of backtestTrades) {
      if (Number.isFinite(t.entryPrice)) levels.push(t.entryPrice);
      if (Number.isFinite(t.exitPrice)) levels.push(t.exitPrice);
      if (Number.isFinite(t.stopPrice)) levels.push(t.stopPrice);
      if (Number.isFinite(t.takeProfitPrice)) levels.push(t.takeProfitPrice);
    }
    for (const p of levels) {
      minP = Math.min(minP, p);
      maxP = Math.max(maxP, p);
    }
    if (!Number.isFinite(minP) || !Number.isFinite(maxP) || maxP <= minP) {
      const last = all[all.length - 1]?.close;
      if (!Number.isFinite(last)) return null;
      minP = last * 0.99;
      maxP = last * 1.01;
    }
    const pad = (maxP - minP) * PAD_PCT || maxP * 0.01;
    minP -= pad;
    maxP += pad;

    const t0 = slice[0].time;
    const t1 = slice[slice.length - 1].time;
    const tSpan = Math.max(1, t1 - t0);

    return {
      w,
      h,
      minP,
      maxP,
      t0,
      t1,
      tSpan,
      slice,
      yOf: (price) => ((maxP - price) / (maxP - minP)) * h,
      xOf: (time) => ((time - t0) / tSpan) * w,
    };
  }

  function clearSvg() {
    if (svg) while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (labelsEl) labelsEl.innerHTML = '';
    if (markersEl) markersEl.innerHTML = '';
  }

  function addLine(scale, price, color, dash) {
    if (!Number.isFinite(price)) return null;
    const y = scale.yOf(price);
    if (y < -8 || y > scale.h + 8) return null;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('x2', String(scale.w));
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '1.5');
    if (dash) line.setAttribute('stroke-dasharray', dash);
    line.setAttribute('opacity', '0.95');
    svg.appendChild(line);
    return y;
  }

  function addLabel(y, text, color, role) {
    if (y == null || !labelsEl) return;
    const el = document.createElement('div');
    el.className = `tv-levels-overlay__label tv-levels-overlay__label--${role}`;
    el.style.top = `${y}px`;
    el.style.borderColor = color;
    el.style.color = color;
    el.textContent = text;
    labelsEl.appendChild(el);
  }

  function drawLevels(scale, src, kind) {
    if (!src) return;
    const buy = src.side === 'LONG';
    const entryColor = buy ? '#2962ff' : '#f7931a';
    const prefix = kind === 'signal' ? 'Signal ' : '';

    const entryY = addLine(scale, src.entryPrice, entryColor, '6 4');
    const slY = addLine(scale, src.stopPrice, '#ef5350', '4 4');
    const tpY = addLine(scale, src.takeProfitPrice, '#26a69a', '4 4');

    if (src.showEntry !== false && Number.isFinite(src.entryPrice)) {
      addLabel(entryY, `${prefix}${buy ? 'Long' : 'Short'} ${fmt(src.entryPrice)}`, entryColor, 'entry');
    }
    if (Number.isFinite(src.stopPrice)) {
      addLabel(slY, `${prefix}SL ${fmt(src.stopPrice)}`, '#ef5350', 'sl');
    }
    if (Number.isFinite(src.takeProfitPrice)) {
      addLabel(tpY, `${prefix}TP ${fmt(src.takeProfitPrice)}`, '#26a69a', 'tp');
    }
  }

  function nearestBar(scale, time) {
    return scale.slice.find((c) => c.time === time)
      || scale.slice.reduce((best, c) => (
        !best || Math.abs(c.time - time) < Math.abs(best.time - time) ? c : best
      ), null);
  }

  function drawBacktestTradeLines(scale) {
    if (!svg || !backtestTrades.length) return;
    // Keep overlay readable: newest trades first, cap count.
    const trades = backtestTrades.slice(-40);
    for (const t of trades) {
      if (!Number.isFinite(t.entryPrice) || t.entryTime == null) continue;
      const x1 = scale.xOf(t.entryTime);
      const x2 = scale.xOf(t.exitTime != null ? t.exitTime : scale.t1);
      const yEntry = scale.yOf(t.entryPrice);
      const buy = t.side === 'LONG';
      const entryColor = buy ? '#2962ff' : '#f7931a';

      const entryLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      entryLine.setAttribute('x1', String(Math.min(x1, x2)));
      entryLine.setAttribute('x2', String(Math.max(x1, x2)));
      entryLine.setAttribute('y1', String(yEntry));
      entryLine.setAttribute('y2', String(yEntry));
      entryLine.setAttribute('stroke', entryColor);
      entryLine.setAttribute('stroke-width', '1.25');
      entryLine.setAttribute('stroke-dasharray', '5 3');
      entryLine.setAttribute('opacity', '0.75');
      svg.appendChild(entryLine);

      if (Number.isFinite(t.stopPrice)) {
        const y = scale.yOf(t.stopPrice);
        const sl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        sl.setAttribute('x1', String(Math.min(x1, x2)));
        sl.setAttribute('x2', String(Math.max(x1, x2)));
        sl.setAttribute('y1', String(y));
        sl.setAttribute('y2', String(y));
        sl.setAttribute('stroke', '#ef5350');
        sl.setAttribute('stroke-width', '1');
        sl.setAttribute('stroke-dasharray', '3 3');
        sl.setAttribute('opacity', '0.55');
        svg.appendChild(sl);
      }
      if (Number.isFinite(t.takeProfitPrice)) {
        const y = scale.yOf(t.takeProfitPrice);
        const tp = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        tp.setAttribute('x1', String(Math.min(x1, x2)));
        tp.setAttribute('x2', String(Math.max(x1, x2)));
        tp.setAttribute('y1', String(y));
        tp.setAttribute('y2', String(y));
        tp.setAttribute('stroke', '#26a69a');
        tp.setAttribute('stroke-width', '1');
        tp.setAttribute('stroke-dasharray', '3 3');
        tp.setAttribute('opacity', '0.55');
        svg.appendChild(tp);
      }
    }
  }

  function drawMarkers(scale) {
    if (!markersEl || !markers.length) return;
    for (const m of markers) {
      if (m.time == null) continue;
      const x = scale.xOf(m.time);
      if (x < -20 || x > scale.w + 20) continue;
      let y;
      if (Number.isFinite(m.price)) y = scale.yOf(m.price);
      else {
        const bar = nearestBar(scale, m.time);
        const px = m.position === 'belowBar' ? bar?.low : bar?.high;
        y = Number.isFinite(px) ? scale.yOf(px) : scale.h * 0.5;
      }
      if (y < -20 || y > scale.h + 20) continue;

      const el = document.createElement('div');
      const below = m.position === 'belowBar';
      el.className = `tv-levels-overlay__marker${below ? ' is-below' : ' is-above'}`;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.color = m.color || '#2962ff';
      el.title = m.text || '';
      if (m.shape === 'circle') el.textContent = '●';
      else if (m.shape === 'arrowUp' || below) el.textContent = '▲';
      else el.textContent = '▼';
      markersEl.appendChild(el);
    }
  }

  function render() {
    if (!active || !ensureDom()) return;
    const all = candles();
    const scale = buildScale(all);
    clearSvg();
    if (!scale) return;

    svg.setAttribute('width', String(scale.w));
    svg.setAttribute('height', String(scale.h));
    svg.setAttribute('viewBox', `0 0 ${scale.w} ${scale.h}`);

    // Backtest trade ranges first (under live levels).
    if (!position) drawBacktestTradeLines(scale);

    // Prefer live position; otherwise show pending signal levels.
    if (position) drawLevels(scale, position, 'position');
    else if (signal) drawLevels(scale, signal, 'signal');

    drawMarkers(scale);
  }

  function wrapChartApi() {
    const c = window.CryptoCharts;
    if (!c || wrapped) return;
    wrapped = true;

    const wrap = (name, after) => {
      const orig = c[name];
      if (typeof orig !== 'function') {
        c[name] = (...args) => { after(...args); };
        return;
      }
      c[name] = (...args) => {
        const ret = orig.apply(c, args);
        try { after(...args); } catch (err) { console.warn('[TvLevels]', err); }
        return ret;
      };
    };

    wrap('setPositionOverlay', (pos) => {
      position = pos && (pos.side === 'LONG' || pos.side === 'SHORT') ? { ...pos } : null;
      render();
    });
    wrap('clearPositionOverlay', () => {
      position = null;
      render();
    });
    wrap('setSignalOverlay', (sig) => {
      signal = sig && (sig.side === 'LONG' || sig.side === 'SHORT') ? { ...sig } : null;
      render();
    });
    wrap('clearSignalOverlay', () => {
      signal = null;
      render();
    });
    wrap('setMarkers', (list) => {
      markers = Array.isArray(list) ? list.map((m) => ({ ...m })) : [];
      render();
    });
    wrap('setBacktestTradeOverlays', (trades) => {
      backtestTrades = Array.isArray(trades) ? trades.map((t) => ({ ...t })) : [];
      render();
    });
    wrap('clearBacktestTradeOverlays', () => {
      backtestTrades = [];
      render();
    });
  }

  function init() {
    if (!document.body.classList.contains('trading-page')) return;
    ensureDom();
    wrapChartApi();

    document.addEventListener('chart-candles-updated', () => render());
    document.addEventListener('chart-candle-tick', () => {
      if (position || signal || markers.length) render();
    });

    // CryptoCharts may finish exporting a moment later.
    let tries = 0;
    const boot = setInterval(() => {
      wrapChartApi();
      tries += 1;
      if (wrapped || tries > 40) clearInterval(boot);
    }, 250);

    window.TvLevelsOverlay = {
      setActive,
      render,
      getState: () => ({ position, signal, markers: markers.length }),
    };

    // Follow chart display mode if already applied.
    const tv = document.body.classList.contains('trading-page--tv');
    setActive(tv);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
