/* Binance-style drawing tools — SVG overlay */
const DRAWING_TOOLS = [
  { id: 'cursor', name: '커서', icon: '↖' },
  { id: 'crosshair', name: '십자선', icon: '+' },
  { id: 'trendline', name: '추세선', icon: '╱' },
  { id: 'ray', name: '광선', icon: '→' },
  { id: 'hline', name: '수평선', icon: '─' },
  { id: 'vline', name: '수직선', icon: '│' },
  { id: 'channel', name: '평행채널', icon: '⫽' },
  { id: 'rectangle', name: '사각형', icon: '▭' },
  { id: 'fib', name: '피보나치', icon: 'φ' },
  { id: 'fibext', name: '피보나치확장', icon: '⇕' },
  { id: 'pitchfork', name: '피치포크', icon: '⋔' },
  { id: 'long', name: '롱 포지션', icon: 'L' },
  { id: 'short', name: '숏 포지션', icon: 'S' },
  { id: 'text', name: '텍스트', icon: 'T' },
  { id: 'arrow', name: '화살표', icon: '➤' },
  { id: 'measure', name: '측정', icon: '↔' },
  { id: 'brush', name: '브러시', icon: '✎' },
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

  function init(chartRef, seriesRef, chartContainer) {
    chart = chartRef;
    candleSeries = seriesRef;
    container = chartContainer;
    svg = document.getElementById('drawingOverlay');
    if (!svg) return;
    renderToolbar();
    bindEvents();
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

  function ptFromEvent(e) {
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return {
      x, y,
      time: xToTime(x),
      price: yToPrice(y),
    };
  }

  function setMode(id) {
    mode = id;
    cancelDraft();
    document.querySelectorAll('.drawing-tool').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === id);
    });
    container?.classList.toggle('chart-area--drawing', id !== 'cursor');
    svg?.classList.toggle('drawing-overlay--active', id !== 'cursor' && !svg.classList.contains('hidden'));
  }

  function cancelDraft() {
    draft = null;
    step = 0;
    points = [];
  }

  function addDrawing(d) {
    drawings.push({ id: Date.now() + Math.random(), ...d });
    redraw();
  }

  function renderToolbar() {
    const bar = document.getElementById('drawingToolbar');
    if (!bar) return;
    bar.innerHTML = DRAWING_TOOLS.map((t) => `
      <button type="button" class="drawing-tool ${t.id === 'cursor' ? 'active' : ''}"
        data-tool="${t.id}" title="${t.name}">${t.icon}</button>
    `).join('') + `
      <button type="button" class="drawing-tool drawing-tool--clear" data-tool="clear" title="모두 지우기">🗑</button>
    `;
    bar.querySelectorAll('.drawing-tool').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tool === 'clear') {
          drawings = [];
          redraw();
          return;
        }
        setMode(btn.dataset.tool);
      });
    });
  }

  function bindEvents() {
    if (!svg) return;
    svg.addEventListener('mousedown', onDown);
    svg.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    if (chart) {
      chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    }
    window.addEventListener('resize', redraw);
  }

  function onDown(e) {
    if (!enabled || mode === 'cursor') return;
    e.preventDefault();
    e.stopPropagation();
    const p = ptFromEvent(e);
    if (p.time == null || p.price == null) return;

    if (mode === 'text') {
      const text = prompt('텍스트 입력', '메모');
      if (text) addDrawing({ type: 'text', points: [p], text });
      return;
    }

    if (['hline'].includes(mode)) {
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
      trendline: 2, ray: 2, vline: 1, channel: 3, rectangle: 2,
      fib: 2, fibext: 2, pitchfork: 3, long: 2, short: 2,
      arrow: 2, measure: 2, crosshair: 1,
    }[mode] || 2;

    if (step >= need) {
      addDrawing({ type: mode, points: [...points] });
      cancelDraft();
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
    if (mode === 'brush' && draft?.points?.length > 1) {
      addDrawing({ type: 'brush', points: draft.points });
    }
    if (mode !== 'brush') return;
    cancelDraft();
  }

  function lineEl(x1, y1, x2, y2, color = '#2962ff', dash = '') {
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
  }

  function renderDrawing(d) {
    const pts = d.points.map((p) => ({
      x: timeToX(p.time),
      y: priceToY(p.price),
      ...p,
    })).filter((p) => p.x != null && p.y != null);
    if (!pts.length) return '';

    let html = '';
    const c = '#2962ff';

    switch (d.type) {
      case 'hline':
        html += lineEl(0, pts[0].y, svg.clientWidth, pts[0].y, c);
        html += `<text x="4" y="${pts[0].y - 4}" fill="${c}" font-size="10">${pts[0].price?.toFixed(2)}</text>`;
        break;
      case 'vline':
        html += lineEl(pts[0].x, 0, pts[0].x, svg.clientHeight, c);
        break;
      case 'trendline':
      case 'ray':
      case 'arrow':
      case 'measure':
        if (pts.length >= 2) {
          let x2 = pts[1].x;
          let y2 = pts[1].y;
          if (d.type === 'ray') {
            const dx = pts[1].x - pts[0].x;
            const dy = pts[1].y - pts[0].y;
            const len = Math.hypot(dx, dy) || 1;
            x2 = pts[0].x + (dx / len) * svg.clientWidth * 2;
            y2 = pts[0].y + (dy / len) * svg.clientHeight * 2;
          }
          html += lineEl(pts[0].x, pts[0].y, x2, y2, c);
          if (d.type === 'arrow') {
            const ang = Math.atan2(y2 - pts[0].y, x2 - pts[0].x);
            const a = 8;
            html += `<polygon points="${x2},${y2} ${x2 - a * Math.cos(ang - 0.4)},${y2 - a * Math.sin(ang - 0.4)} ${x2 - a * Math.cos(ang + 0.4)},${y2 - a * Math.sin(ang + 0.4)}" fill="${c}"/>`;
          }
          if (d.type === 'measure') {
            const pct = pts[0].price ? (((pts[1].price - pts[0].price) / pts[0].price) * 100).toFixed(2) : '0';
            html += `<text x="${(pts[0].x + pts[1].x) / 2}" y="${(pts[0].y + pts[1].y) / 2 - 6}" fill="${c}" font-size="10">${pct}%</text>`;
          }
        }
        break;
      case 'rectangle':
        if (pts.length >= 2) {
          const x = Math.min(pts[0].x, pts[1].x);
          const y = Math.min(pts[0].y, pts[1].y);
          const w = Math.abs(pts[1].x - pts[0].x);
          const h = Math.abs(pts[1].y - pts[0].y);
          html += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(41,98,255,0.08)" stroke="${c}" stroke-width="1.5"/>`;
        }
        break;
      case 'channel':
        if (pts.length >= 3) {
          html += lineEl(pts[0].x, pts[0].y, pts[1].x, pts[1].y, c);
          const dy = pts[2].y - pts[0].y;
          html += lineEl(pts[0].x, pts[0].y + dy, pts[1].x, pts[1].y + dy, c, '4 4');
        }
        break;
      case 'fib':
      case 'fibext':
        if (pts.length >= 2) {
          const levels = d.type === 'fib' ? FIB_LEVELS : FIB_EXT_LEVELS;
          const top = Math.min(pts[0].y, pts[1].y);
          const bot = Math.max(pts[0].y, pts[1].y);
          const x1 = Math.min(pts[0].x, pts[1].x);
          const x2 = Math.max(pts[0].x, pts[1].x);
          levels.forEach((lv) => {
            const y = bot - (bot - top) * lv;
            html += lineEl(x1, y, x2, y, '#f7931a', '3 3');
            html += `<text x="${x2 + 2}" y="${y + 3}" fill="#f7931a" font-size="9">${(lv * 100).toFixed(1)}%</text>`;
          });
        }
        break;
      case 'pitchfork':
        if (pts.length >= 3) {
          const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
          [pts[2], { x: pts[2].x + (pts[0].x - mid.x), y: pts[2].y + (pts[0].y - mid.y) },
            { x: pts[2].x + (pts[1].x - mid.x), y: pts[2].y + (pts[1].y - mid.y) }].forEach((p) => {
            html += lineEl(pts[2].x, pts[2].y, p.x + (p.x - pts[2].x) * 3, p.y + (p.y - pts[2].y) * 3, c);
          });
        }
        break;
      case 'long':
      case 'short':
        if (pts.length >= 2) {
          const entry = pts[0].y;
          const target = pts[1].y;
          const x = Math.min(pts[0].x, pts[1].x);
          const w = Math.abs(pts[1].x - pts[0].x) || 80;
          const isLong = d.type === 'long';
          const profitY = isLong ? Math.min(entry, target) : Math.max(entry, target);
          const lossY = isLong ? Math.max(entry, target) : Math.min(entry, target);
          html += `<rect x="${x}" y="${profitY}" width="${w}" height="${Math.abs(entry - profitY)}" fill="rgba(38,166,154,0.25)" stroke="#26a69a"/>`;
          html += `<rect x="${x}" y="${Math.min(entry, lossY)}" width="${w}" height="${Math.abs(entry - lossY)}" fill="rgba(239,83,80,0.25)" stroke="#ef5350"/>`;
          html += lineEl(x, entry, x + w, entry, '#d1d4dc');
        }
        break;
      case 'text':
        html += `<text x="${pts[0].x}" y="${pts[0].y}" fill="#d1d4dc" font-size="12">${d.text || ''}</text>`;
        break;
      case 'brush':
        if (pts.length > 1) {
          html += `<polyline points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#2962ff" stroke-width="1.5"/>`;
        }
        break;
      case 'crosshair':
        html += lineEl(pts[0].x, 0, pts[0].x, svg.clientHeight, '#787b86', '4 4');
        html += lineEl(0, pts[0].y, svg.clientWidth, pts[0].y, '#787b86', '4 4');
        break;
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
    svg?.classList.toggle('hidden', !val);
  }

  function isDrawingMode() {
    return mode !== 'cursor';
  }

  function clear() {
    drawings = [];
    cancelDraft();
    redraw();
  }

  return { init, redraw, setEnabled, isDrawingMode, clear, setMode };
})();
