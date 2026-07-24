/* TradingView-style drawing tools — SVG overlay on Lightweight Charts */
const DRAWING_SVG = {
  cursor: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4 2l10 7.2-4.2 1.2L12 16l-1.6.6-2.2-5.4L4 14V2z" fill="currentColor"/></svg>',
  crosshair: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2v14M2 9h14" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
  trendline: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3 14L15 4" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="3" cy="14" r="1.4" fill="currentColor"/><circle cx="15" cy="4" r="1.4" fill="currentColor"/></svg>',
  ray: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3 13L12 5h4" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="3" cy="13" r="1.4" fill="currentColor"/></svg>',
  hline: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M2 9h14" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="9" r="1.5" fill="currentColor"/></svg>',
  vline: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2v14" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="9" r="1.5" fill="currentColor"/></svg>',
  channel: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M2 12l10-8M2 16l10-8" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
  rectangle: '<svg viewBox="0 0 18 18" aria-hidden="true"><rect x="3" y="4" width="12" height="10" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
  fib: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3 14h12M3 10.5h12M3 8h12M3 4h12" stroke="currentColor" stroke-width="1.2"/><path d="M3 14V4" stroke="currentColor" stroke-width="1.4"/></svg>',
  fibext: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3 15h12M3 11h12M3 7h12M3 3h12" stroke="currentColor" stroke-width="1.1"/><path d="M4 15l5-12 5 12" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
  pitchfork: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 15V6M5 15V9l4-3 4 3v6" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
  long: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 14V5M6 8l3-3 3 3" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M4 14h10" stroke="currentColor" stroke-width="1.3"/></svg>',
  short: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 4v9M6 10l3 3 3-3" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M4 4h10" stroke="currentColor" stroke-width="1.3"/></svg>',
  text: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4h10M9 4v10" stroke="currentColor" stroke-width="1.6"/><path d="M6 14h6" stroke="currentColor" stroke-width="1.3"/></svg>',
  arrow: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4 14L14 4M9 4h5v5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
  measure: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3 12h12M3 12l2-2M3 12l2 2M15 12l-2-2M15 12l-2 2" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
  brush: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3 15c2-1 3-3 4-5l6-6 2 2-6 6c-2 1-4 2-6 3z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>',
  magnet: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M5 3v6a4 4 0 008 0V3M5 3h2v6a2 2 0 004 0V3h2" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
  clear: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M5 6h8l-.7 9H5.7L5 6zm2-2h4l1 2H6l1-2zM4 6h10" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
};

const DRAWING_TOOLS = [
  { id: 'cursor', name: 'Cursor' },
  { id: 'crosshair', name: 'Crosshair' },
  { id: 'trendline', name: 'Trend Line' },
  { id: 'ray', name: 'Ray' },
  { id: 'hline', name: 'Horizontal Line' },
  { id: 'vline', name: 'Vertical Line' },
  { id: 'channel', name: 'Parallel Channel' },
  { id: 'rectangle', name: 'Rectangle' },
  { id: 'fib', name: 'Fib Retracement' },
  { id: 'fibext', name: 'Fib Extension' },
  { id: 'pitchfork', name: 'Pitchfork' },
  { id: 'long', name: 'Long Position' },
  { id: 'short', name: 'Short Position' },
  { id: 'text', name: 'Text' },
  { id: 'arrow', name: 'Arrow' },
  { id: 'measure', name: 'Measure' },
  { id: 'brush', name: 'Brush' },
];

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_EXT_LEVELS = [0, 0.618, 1, 1.618, 2.618];

const DrawingManager = (() => {
  let chart = null;
  let candleSeries = null;
  let container = null;
  let svg = null;
  let mode = 'cursor';
  let drawings = [];
  let draft = null;
  let step = 0;
  let points = [];
  let enabled = true;
  let magnet = true;

  function isTradingPage() {
    return document.body.classList.contains('trading-page');
  }

  function init(chartRef, seriesRef, chartContainer) {
    chart = chartRef;
    candleSeries = seriesRef;
    container = chartContainer;
    svg = document.getElementById('drawingOverlay');
    if (!svg) return;
    renderToolbar();
    bindEvents();
    if (isTradingPage()) {
      document.getElementById('drawingToolbar')?.classList.remove('hidden');
      setEnabled(true);
    }
    redraw();
  }

  function priceToY(price) {
    if (price == null || !candleSeries) return null;
    return candleSeries.priceToCoordinate(price);
  }

  function yToPrice(y) {
    if (y == null || !candleSeries) return null;
    return candleSeries.coordinateToPrice(y);
  }

  function timeToX(time) {
    if (time == null || !chart) return null;
    return chart.timeScale().timeToCoordinate(time);
  }

  function xToTime(x) {
    if (x == null || !chart) return null;
    return chart.timeScale().coordinateToTime(x);
  }

  function nearestCandle(time) {
    const candles = window.__lastCandles || [];
    if (!candles.length || time == null) return null;
    let best = candles[0];
    let bestDist = Math.abs(best.time - time);
    for (let i = 1; i < candles.length; i++) {
      const d = Math.abs(candles[i].time - time);
      if (d < bestDist) {
        best = candles[i];
        bestDist = d;
      }
    }
    return best;
  }

  function ptFromEvent(e) {
    const rect = svg.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let y = e.clientY - rect.top;
    let time = xToTime(x);
    let price = yToPrice(y);

    if (magnet && time != null && price != null) {
      const bar = nearestCandle(time);
      if (bar) {
        time = bar.time;
        const levels = [bar.open, bar.high, bar.low, bar.close];
        price = levels.reduce((a, b) => (Math.abs(b - price) < Math.abs(a - price) ? b : a));
        const sx = timeToX(time);
        const sy = priceToY(price);
        if (sx != null) x = sx;
        if (sy != null) y = sy;
      }
    }

    return { x, y, time, price };
  }

  function setMode(id) {
    mode = id;
    cancelDraft();
    document.querySelectorAll('.drawing-tool[data-tool]').forEach((btn) => {
      if (btn.dataset.tool === 'magnet' || btn.dataset.tool === 'clear') return;
      btn.classList.toggle('active', btn.dataset.tool === id);
    });
    container?.classList.toggle('chart-area--drawing', id !== 'cursor');
    svg?.classList.toggle('drawing-overlay--active', id !== 'cursor' && enabled);
  }

  function setMagnet(on) {
    magnet = Boolean(on);
    document.querySelectorAll('.drawing-tool[data-tool="magnet"]').forEach((btn) => {
      btn.classList.toggle('active', magnet);
      btn.setAttribute('aria-pressed', magnet ? 'true' : 'false');
    });
  }

  function cancelDraft() {
    draft = null;
    step = 0;
    points = [];
  }

  let undoStack = [];
  const UNDO_LIMIT = 50;

  function pushUndo() {
    undoStack.push(drawings.map((d) => ({ ...d, points: d.points.map((p) => ({ ...p })) })));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }

  function undo() {
    if (draft || points.length) {
      cancelDraft();
      redraw();
      return;
    }
    if (!undoStack.length) return;
    drawings = undoStack.pop();
    redraw();
  }

  function addDrawing(d) {
    pushUndo();
    drawings.push({ id: Date.now() + Math.random(), ...d });
    redraw();
  }

  function renderToolbar() {
    const bar = document.getElementById('drawingToolbar');
    if (!bar) return;
    bar.innerHTML = DRAWING_TOOLS.map((t) => `
      <button type="button" class="drawing-tool ${t.id === 'cursor' ? 'active' : ''}"
        data-tool="${t.id}" title="${t.name}">${DRAWING_SVG[t.id] || t.id}</button>
    `).join('') + `
      <button type="button" class="drawing-tool drawing-tool--magnet ${magnet ? 'active' : ''}"
        data-tool="magnet" title="Magnet (snap to OHLC)" aria-pressed="${magnet ? 'true' : 'false'}">${DRAWING_SVG.magnet}</button>
      <button type="button" class="drawing-tool drawing-tool--clear" data-tool="clear" title="Remove all">${DRAWING_SVG.clear}</button>
    `;
    bar.querySelectorAll('.drawing-tool').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        if (tool === 'clear') {
          if (drawings.length) pushUndo();
          drawings = [];
          cancelDraft();
          redraw();
          return;
        }
        if (tool === 'magnet') {
          setMagnet(!magnet);
          return;
        }
        setMode(tool);
      });
    });
  }

  function bindEvents() {
    if (!svg) return;
    svg.addEventListener('mousedown', onDown);
    svg.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', onKeyDown);

    if (chart) {
      chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    }
    window.addEventListener('resize', redraw);
  }

  function onKeyDown(e) {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if ((e.key || '').toLowerCase() !== 'z') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (!enabled) return;
    e.preventDefault();
    undo();
  }

  function onDown(e) {
    if (!enabled || mode === 'cursor') return;
    e.preventDefault();
    e.stopPropagation();
    const p = ptFromEvent(e);
    if (p.time == null || p.price == null) return;

    if (mode === 'text') {
      const text = window.prompt('Text', 'Note');
      if (text) addDrawing({ type: 'text', points: [p], text });
      return;
    }

    if (mode === 'hline' || mode === 'vline' || mode === 'crosshair') {
      addDrawing({ type: mode, points: [p] });
      return;
    }

    if (mode === 'brush') {
      points = [p];
      draft = { type: 'brush', points: [...points] };
      return;
    }

    points.push(p);
    step++;

    const need = {
      trendline: 2, ray: 2, channel: 3, rectangle: 2,
      fib: 2, fibext: 2, pitchfork: 3, long: 2, short: 2,
      arrow: 2, measure: 2,
    }[mode] || 2;

    if (step >= need) {
      addDrawing({ type: mode, points: [...points] });
      cancelDraft();
      // Stay on the same tool (TradingView behavior).
    } else {
      draft = { type: mode, points: [...points] };
    }
  }

  function onMove(e) {
    if (!draft || mode === 'brush') {
      if (mode === 'brush' && points.length && e.buttons === 1) {
        const p = ptFromEvent(e);
        if (p.time != null) {
          draft.points.push(p);
          redraw();
        }
      }
      return;
    }
    draft.cursor = ptFromEvent(e);
    redraw();
  }

  function onUp() {
    if (mode === 'brush' && draft) {
      if (draft.points.length > 1) addDrawing(draft);
      cancelDraft();
      redraw();
    }
  }

  function line(p1, p2, color = '#2962ff', width = 1.5, dash = '') {
    const x1 = timeToX(p1.time);
    const y1 = priceToY(p1.price);
    const x2 = timeToX(p2.time);
    const y2 = priceToY(p2.price);
    if ([x1, y1, x2, y2].some((v) => v == null)) return '';
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" ${dash ? `stroke-dasharray="${dash}"` : ''} />`;
  }

  function renderDrawing(d) {
    const pts = d.points || [];
    if (!pts.length) return '';
    let html = '';
    switch (d.type) {
      case 'trendline':
      case 'arrow':
        if (pts.length >= 2) html += line(pts[0], pts[1]);
        break;
      case 'ray': {
        if (pts.length < 2) break;
        const x1 = timeToX(pts[0].time);
        const y1 = priceToY(pts[0].price);
        const x2 = timeToX(pts[1].time);
        const y2 = priceToY(pts[1].price);
        if ([x1, y1, x2, y2].some((v) => v == null)) break;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const scale = 5000 / len;
        html += `<line x1="${x1}" y1="${y1}" x2="${x1 + dx * scale}" y2="${y1 + dy * scale}" stroke="#2962ff" stroke-width="1.5" />`;
        break;
      }
      case 'hline': {
        const y = priceToY(pts[0].price);
        if (y == null) break;
        html += `<line x1="0" y1="${y}" x2="100%" y2="${y}" stroke="#f7931a" stroke-width="1.25" stroke-dasharray="6 4" />`;
        break;
      }
      case 'vline':
      case 'crosshair': {
        const x = timeToX(pts[0].time);
        if (x == null) break;
        html += `<line x1="${x}" y1="0" x2="${x}" y2="100%" stroke="#787b86" stroke-width="1" stroke-dasharray="4 4" />`;
        if (d.type === 'crosshair') {
          const y = priceToY(pts[0].price);
          if (y != null) html += `<line x1="0" y1="${y}" x2="100%" y2="${y}" stroke="#787b86" stroke-width="1" stroke-dasharray="4 4" />`;
        }
        break;
      }
      case 'rectangle': {
        if (pts.length < 2) break;
        const x1 = timeToX(pts[0].time);
        const y1 = priceToY(pts[0].price);
        const x2 = timeToX(pts[1].time);
        const y2 = priceToY(pts[1].price);
        if ([x1, y1, x2, y2].some((v) => v == null)) break;
        const rx = Math.min(x1, x2);
        const ry = Math.min(y1, y2);
        html += `<rect x="${rx}" y="${ry}" width="${Math.abs(x2 - x1)}" height="${Math.abs(y2 - y1)}" fill="rgba(41,98,255,0.08)" stroke="#2962ff" stroke-width="1.25" />`;
        break;
      }
      case 'channel': {
        if (pts.length < 3) break;
        html += line(pts[0], pts[1], '#2962ff');
        const shift = pts[2].price - pts[0].price;
        const q0 = { time: pts[0].time, price: pts[0].price + shift };
        const q1 = { time: pts[1].time, price: pts[1].price + shift };
        html += line(q0, q1, '#2962ff', 1.25, '4 3');
        break;
      }
      case 'fib':
      case 'fibext': {
        if (pts.length < 2) break;
        const levels = d.type === 'fib' ? FIB_LEVELS : FIB_EXT_LEVELS;
        const hi = Math.max(pts[0].price, pts[1].price);
        const lo = Math.min(pts[0].price, pts[1].price);
        const span = hi - lo || 1;
        const x1 = timeToX(pts[0].time);
        const x2 = timeToX(pts[1].time);
        if (x1 == null || x2 == null) break;
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        for (const lv of levels) {
          const price = d.type === 'fib' ? hi - span * lv : lo + span * lv;
          const y = priceToY(price);
          if (y == null) continue;
          html += `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="#787b86" stroke-width="1" />`;
          html += `<text x="${right + 4}" y="${y - 2}" fill="#b2b5be" font-size="10">${lv}</text>`;
        }
        break;
      }
      case 'pitchfork': {
        if (pts.length < 3) break;
        html += line(pts[0], pts[1], '#26a69a');
        html += line(pts[0], pts[2], '#26a69a');
        const mid = {
          time: (pts[1].time + pts[2].time) / 2,
          price: (pts[1].price + pts[2].price) / 2,
        };
        html += line(pts[0], mid, '#26a69a', 1.25, '4 3');
        break;
      }
      case 'long':
      case 'short': {
        if (pts.length < 2) break;
        const color = d.type === 'long' ? '#26a69a' : '#ef5350';
        html += line(pts[0], pts[1], color, 1.5);
        const y0 = priceToY(pts[0].price);
        const y1 = priceToY(pts[1].price);
        const x0 = timeToX(pts[0].time);
        const x1 = timeToX(pts[1].time);
        if ([y0, y1, x0, x1].every((v) => v != null)) {
          html += `<rect x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" fill="${color}" opacity="0.12" />`;
        }
        break;
      }
      case 'text': {
        const x = timeToX(pts[0].time);
        const y = priceToY(pts[0].price);
        if (x == null || y == null) break;
        html += `<text x="${x}" y="${y}" fill="#d1d4dc" font-size="12" font-weight="600">${(d.text || '').replace(/</g, '&lt;')}</text>`;
        break;
      }
      case 'measure': {
        if (pts.length < 2) break;
        html += line(pts[0], pts[1], '#ff9800', 1.25, '4 3');
        const pct = ((pts[1].price - pts[0].price) / pts[0].price) * 100;
        const mx = ((timeToX(pts[0].time) || 0) + (timeToX(pts[1].time) || 0)) / 2;
        const my = ((priceToY(pts[0].price) || 0) + (priceToY(pts[1].price) || 0)) / 2;
        html += `<text x="${mx}" y="${my - 6}" fill="#ff9800" font-size="11" text-anchor="middle">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</text>`;
        break;
      }
      case 'brush': {
        const coords = pts.map((p) => {
          const x = timeToX(p.time);
          const y = priceToY(p.price);
          return x != null && y != null ? `${x},${y}` : null;
        }).filter(Boolean);
        if (coords.length >= 2) {
          html += `<polyline points="${coords.join(' ')}" fill="none" stroke="#e91e63" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />`;
        }
        break;
      }
      default:
        break;
    }
    return html;
  }

  function renderDraft() {
    if (!draft) return '';
    const temp = { ...draft };
    if (draft.cursor) {
      temp.points = [...draft.points, draft.cursor];
    }
    return renderDrawing(temp);
  }

  function redraw() {
    if (!svg) return;
    const w = container?.clientWidth || svg.clientWidth;
    const h = container?.clientHeight || svg.clientHeight;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = drawings.map(renderDrawing).join('') + renderDraft();
  }

  function setEnabled(val) {
    enabled = val;
    if (!isTradingPage()) {
      svg?.classList.toggle('hidden', !val);
    } else {
      svg?.classList.remove('hidden');
    }
    if (!enabled) setMode('cursor');
    else svg?.classList.toggle('drawing-overlay--active', mode !== 'cursor');
  }

  function isDrawingMode() {
    return mode !== 'cursor';
  }

  function clear() {
    if (drawings.length) pushUndo();
    drawings = [];
    cancelDraft();
    redraw();
  }

  return { init, redraw, setEnabled, isDrawingMode, clear, setMode, undo, setMagnet };
})();
