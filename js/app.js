const COINGECKO_API = 'https://api.coingecko.com/api/v3';
const isTradingPage = document.body.classList.contains('trading-page');

function binanceRestBase() {
  return isTradingPage ? 'https://fapi.binance.com/fapi/v1' : 'https://api.binance.com/api/v3';
}

function binanceWsCombinedBase() {
  return isTradingPage ? 'wss://fstream.binance.com' : 'wss://stream.binance.com:9443';
}

function binanceWsSingleBase() {
  return isTradingPage ? 'wss://fstream.binance.com/ws' : 'wss://stream.binance.com:9443/ws';
}

const BINANCE_API = binanceRestBase();
const BINANCE_WS = binanceWsCombinedBase();

const INTERVALS = {
  '1m':  { label: '1분',  seconds: 60,    targetBars: 4320 },
  '5m':  { label: '5분',  seconds: 300,   targetBars: 5760 },
  '15m': { label: '15분', seconds: 900,   targetBars: 6720 },
  '1h':  { label: '1시간', seconds: 3600,  targetBars: 8760 },
  '4h':  { label: '4시간', seconds: 14400, targetBars: 4380 },
  '1d':  { label: '1일',  seconds: 86400, targetBars: 2000 },
};

const MAX_CHART_BARS = 50000;

const cache = new Map();
const CACHE_TTL = 30_000;

let chart = null;
let candleSeries = null;
let lineSeries = null;
let volumeSeries = null;
let resizeObserver = null;
let chartInitialized = false;
let ws = null;
let miniTickerWs = null;
let binanceSymbolMap = null;
let candleRolloverTimer = null;
let catchUpInFlight = false;
let visibilityCatchUpBound = false;
const LIVE_INDICATOR_MS = 16;
let lastLiveIndicatorAt = 0;
let liveIndicatorTimer = null;
let liveIndicatorNeedsNewBar = false;
let pendingTick = null;
let liveRenderRaf = null;
let panningSetup = false;
let loadMoreDebounce = null;
let swingHighPriceLine = null;
let swingLowPriceLine = null;
let swingStopPriceLine = null;
let backtestSlSegments = [];
let backtestTpSegments = [];
let signalOverlay = null;
let positionOverlay = null;
let positionOverlayPending = null;
let positionAutoscalePrices = [];
let positionSlSeries = null;
let positionTpSeries = null;
let positionEntrySeries = null;
let pendingSwingLevels = null;
let pendingStopLossPrice = null;
let slTpDragState = null;
let onSlTpDragCallback = null;

function setSlTpDragHandler(fn) {
  onSlTpDragCallback = typeof fn === 'function' ? fn : null;
}

function validateSlTpPrice(side, entryPrice, role, price) {
  if (!Number.isFinite(price) || !Number.isFinite(entryPrice)) return false;
  if (side === 'LONG') {
    if (role === 'sl') return price < entryPrice;
    if (role === 'tp') return price > entryPrice;
  }
  if (side === 'SHORT') {
    if (role === 'sl') return price > entryPrice;
    if (role === 'tp') return price < entryPrice;
  }
  return false;
}

function priceFromClientY(clientY) {
  const main = document.querySelector('.chart-main');
  if (!main || !candleSeries) return null;
  const rect = main.getBoundingClientRect();
  const y = clientY - rect.top;
  const price = candleSeries.coordinateToPrice(y);
  return Number.isFinite(price) ? price : null;
}

function onSlTpDragMove(e) {
  if (!slTpDragState || !positionOverlayPending) return;
  const { role } = slTpDragState;
  const { side, entryPrice } = positionOverlayPending;
  const price = priceFromClientY(e.clientY);
  if (price == null || !validateSlTpPrice(side, entryPrice, role, price)) return;

  if (role === 'sl') positionOverlayPending.stopPrice = price;
  else if (role === 'tp') positionOverlayPending.takeProfitPrice = price;

  positionAutoscalePrices = [
    positionOverlayPending.showEntry !== false ? positionOverlayPending.entryPrice : null,
    positionOverlayPending.stopPrice,
    positionOverlayPending.takeProfitPrice,
  ].filter(Number.isFinite);
  updatePositionOverlayLabels();
  onSlTpDragCallback?.({
    role,
    price,
    side,
    entryPrice,
    stopPrice: positionOverlayPending.stopPrice,
    takeProfitPrice: positionOverlayPending.takeProfitPrice,
  });
}

function onSlTpDragEnd() {
  slTpDragState = null;
  document.removeEventListener('mousemove', onSlTpDragMove);
  document.removeEventListener('mouseup', onSlTpDragEnd);
  document.body.classList.remove('pos-sl-tp-dragging');
}

function startSlTpDrag(role, e) {
  if (!positionOverlayPending || (role !== 'sl' && role !== 'tp')) return;
  e.preventDefault();
  slTpDragState = { role };
  document.body.classList.add('pos-sl-tp-dragging');
  document.addEventListener('mousemove', onSlTpDragMove);
  document.addEventListener('mouseup', onSlTpDragEnd);
}

function bindPositionLabelDrag(wrap) {
  if (!wrap || wrap.dataset.dragBound) return;
  wrap.dataset.dragBound = '1';
  wrap.addEventListener('mousedown', (e) => {
    const role = e.target.closest('[data-drag-role]')?.dataset.dragRole;
    if (role) startSlTpDrag(role, e);
  });
}
function isPriceScaleAuto() {
  if (!chart) return true;
  try {
    return chart.priceScale('right').options().autoScale !== false;
  } catch {
    return true;
  }
}

function resetPriceScaleToAuto() {
  if (!chart) return;
  chart.priceScale('right').applyOptions({ autoScale: true });
}

const state = {
  selectedCoin: null,
  coins: [],
  chartType: 'candlestick',
  interval: '1h',
  binanceSymbol: null,
  lastCandles: [],
  formingCandleTime: null,
  isFollowingRealtime: true,
  programmaticScroll: false,
  lastTickPrice: null,
  lastTickTime: 0,
  loadingMore: false,
  canLoadMore: true,
  dragging: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── API helpers ──────────────────────────────────────────────

async function fetchWithCache(url, ttl = CACHE_TTL, retries = 2) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < ttl) return cached.data;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 429 && attempt < retries) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw new Error(response.status === 429
          ? 'API 요청 한도에 도달했습니다.'
          : `API 오류: ${response.status}`);
      }
      const data = await response.json();
      cache.set(url, { data, time: Date.now() });
      return data;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function fetchTopCoinsFromBinance() {
  const data = await fetchWithCache(`${BINANCE_API}/ticker/24hr`, 30_000);
  const stablecoins = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'TUSD', 'USDP', 'FDUSD', 'USDE']);
  return data
    .filter((t) => t.symbol.endsWith('USDT') && !stablecoins.has(t.symbol.replace('USDT', '')))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 30)
    .map((t, i) => {
      const base = t.symbol.replace('USDT', '');
      return {
        id: base.toLowerCase(),
        name: base,
        symbol: base.toLowerCase(),
        image: '',
        current_price: parseFloat(t.lastPrice),
        price_change_percentage_24h: parseFloat(t.priceChangePercent),
        market_cap_rank: i + 1,
        high_24h: parseFloat(t.highPrice),
        low_24h: parseFloat(t.lowPrice),
        total_volume: parseFloat(t.quoteVolume),
        market_cap: null,
      };
    });
}

async function fetchTopCoins(limit = 30) {
  try {
    return await fetchWithCache(
      `${COINGECKO_API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false&price_change_percentage=24h`
    );
  } catch {
    return fetchTopCoinsFromBinance();
  }
}

async function searchCoins(query) {
  if (!query || query.length < 2) return [];
  const data = await fetchWithCache(`${COINGECKO_API}/search?query=${encodeURIComponent(query)}`);
  return (data.coins || []).slice(0, 8);
}

async function loadBinanceSymbols() {
  if (binanceSymbolMap) return binanceSymbolMap;
  const data = await fetchWithCache(`${BINANCE_API}/exchangeInfo`, 3600_000);
  binanceSymbolMap = new Map();
  for (const s of data.symbols) {
    if (s.quoteAsset !== 'USDT' || s.status !== 'TRADING') continue;
    // Futures exchangeInfo includes quarterly delivery contracts (BTCUSDT_261225).
    // Prefer USDT-M perpetuals only — delivery pairs have flat/illiquid 1m bars
    // that leave the chart blank (zero price range).
    if (isTradingPage) {
      if (s.contractType && s.contractType !== 'PERPETUAL') continue;
      if (s.symbol !== `${s.baseAsset}USDT`) continue;
    }
    binanceSymbolMap.set(s.baseAsset.toUpperCase(), s.symbol);
  }
  return binanceSymbolMap;
}

async function resolveBinanceSymbol(coin) {
  const map = await loadBinanceSymbols();
  const base = coin.symbol?.toUpperCase();
  if (!base) return null;
  const exact = `${base}USDT`;
  // Always prefer the plain perpetual/spot pair name when present.
  for (const sym of map.values()) {
    if (sym === exact) return exact;
  }
  if (map.has(base)) return map.get(base);
  const idBase = coin.id?.toUpperCase();
  if (idBase && map.has(idBase)) return map.get(idBase);
  if (isTradingPage && /^[A-Z0-9]+$/.test(base)) return exact;
  return null;
}

async function fetchKlines(symbol, interval, limit) {
  if (window.KlineLoader) {
    return KlineLoader.fetchHistorical(
      symbol,
      interval,
      limit,
      (url) => fetchWithCache(url, 5_000),
    );
  }
  const url = `${binanceRestBase()}/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(limit, 1000)}`;
  const data = await fetchWithCache(url, 5_000);
  return data.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function fetch24hTicker(symbol) {
  const url = `${binanceRestBase()}/ticker/24hr?symbol=${symbol}`;
  return fetchWithCache(url, 15_000);
}

// ── Candle processing (no gaps) ──────────────────────────────

function fillCandleGaps(candles, intervalSeconds) {
  if (candles.length < 2) return candles;
  const result = [candles[0]];
  for (let i = 1; i < candles.length; i++) {
    const prev = result[result.length - 1];
    const curr = candles[i];
    let t = prev.time + intervalSeconds;
    while (t < curr.time) {
      result.push({ time: t, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0 });
      t += intervalSeconds;
    }
    result.push(curr);
  }
  return result;
}

/** Deduplicate / sort / drop invalid bars so Lightweight Charts never gets bad setData. */
function sanitizeCandleSeries(candles) {
  const byTime = new Map();
  for (const c of candles) {
    if (!c || !Number.isFinite(c.time)) continue;
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    if (![open, high, low, close].every(Number.isFinite)) continue;
    byTime.set(c.time, {
      time: c.time,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume: Number.isFinite(c.volume) ? c.volume : 0,
    });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Fetch latest klines bypassing cache (required after reconnect / tab wake). */
async function fetchRecentKlinesUncached(symbol, interval, limit = 200) {
  const url = `${binanceRestBase()}/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(limit, 1000)}`;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`klines ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Invalid klines response');
  return window.KlineLoader
    ? KlineLoader.mapKlines(data)
    : data.map((k) => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
}

/**
 * Binance-style live candles:
 * - @kline is the source of truth for OHLCV
 * - @trade only refines the current forming bar (or opens the next adjacent bar)
 * - Never invent flat bridge bars; on holes, REST catch-up
 * - bookTicker / miniTicker must NOT write candle OHLC
 */
function replaceCandleSeriesData(candles) {
  if (!candleSeries || !candles.length) return;
  const intervalSec = getIntervalSeconds();
  const filled = sanitizeCandleSeries(fillCandleGaps(candles, intervalSec));
  if (!filled.length) return;
  state.lastCandles = filled;
  candleSeries.setData(filled.map(({ time, open, high, low, close }) => (
    { time, open, high, low, close }
  )));
  lineSeries?.setData(filled.map(({ time, close }) => ({ time, value: close })));
  volumeSeries?.setData(filled.map(({ time, open, close, volume }) => ({
    time,
    value: volume,
    color: close >= open ? TV_COLORS.volumeUp : TV_COLORS.volumeDown,
  })));
  state.formingCandleTime = filled[filled.length - 1]?.time ?? null;
  if (typeof IndicatorManager !== 'undefined') IndicatorManager.update(filled);
  const last = filled[filled.length - 1];
  if (last) updateLiveOhlcDisplay(last);
}

async function catchUpRecentCandles() {
  if (!state.binanceSymbol || !candleSeries || catchUpInFlight) return;
  catchUpInFlight = true;
  try {
    const recent = await fetchRecentKlinesUncached(state.binanceSymbol, state.interval, 300);
    if (!recent?.length || !state.binanceSymbol) return;

    const byTime = new Map();
    for (const c of state.lastCandles) byTime.set(c.time, c);
    for (const c of recent) byTime.set(c.time, c);

    const lastRemote = recent[recent.length - 1];
    if (
      lastRemote
      && state.lastTickPrice != null
      && state.lastTickTime > lastRemote.time * 1000
      && getCandleOpenTime(state.lastTickTime, getIntervalSeconds()) === lastRemote.time
    ) {
      const cur = byTime.get(lastRemote.time) || lastRemote;
      byTime.set(lastRemote.time, {
        ...cur,
        close: state.lastTickPrice,
        high: Math.max(cur.high, state.lastTickPrice),
        low: Math.min(cur.low, state.lastTickPrice),
      });
    }

    const merged = [...byTime.values()].sort((a, b) => a.time - b.time);
    replaceCandleSeriesData(merged);

    if (state.isFollowingRealtime) {
      state.programmaticScroll = true;
      chart?.timeScale().scrollToRealTime();
      state.programmaticScroll = false;
    }
  } catch (err) {
    console.warn('Candle catch-up failed:', err);
  } finally {
    catchUpInFlight = false;
  }
}

function bindVisibilityCatchUp() {
  if (visibilityCatchUpBound) return;
  visibilityCatchUpBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.binanceSymbol) {
      catchUpRecentCandles();
    }
  });
}

function scheduleCatchUp(reason) {
  if (catchUpInFlight) return;
  catchUpRecentCandles().catch(() => {});
  if (reason) console.debug('candle catch-up:', reason);
}

function updateHeaderPrice(price) {
  if (!state.binanceSymbol || !state.selectedCoin || !Number.isFinite(price)) return;
  const headerPrice = document.querySelector('#currentPrice');
  if (!headerPrice) return;
  const prevHeader = parseFloat(headerPrice.dataset?.lastPrice || '0');
  headerPrice.textContent = formatPrice(price);
  headerPrice.dataset.lastPrice = String(price);
  if (prevHeader && price !== prevHeader) {
    flashPrice(headerPrice, price > prevHeader ? 'up' : 'down');
  }
}

function waitForContainer(container) {
  return new Promise((resolve) => {
    if (container.clientWidth > 0 && container.clientHeight > 0) {
      resolve();
      return;
    }
    const ro = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        ro.disconnect();
        resolve();
      }
    });
    ro.observe(container);
    setTimeout(() => { ro.disconnect(); resolve(); }, 800);
  });
}

// ── Chart (TradingView / Binance style) ─────────────────────
// Use Lightweight Charts native scroll/scale:
//   body drag  → time pan only
//   price axis → price zoom (disables autoScale)
//   time axis  → time zoom
//   dblclick   → restore autoScale
// When autoScale is on, panning time refits price to visible bars (Binance default).

function candleAutoscaleProvider(original) {
  // Scale from visible candle OHLC, but include open-position SL/TP/entry so
  // those dashed lines stay on screen (they sit outside the wick range).
  const range = getVisibleBarsPriceRange(0.06);
  if (range) {
    for (const p of positionAutoscalePrices) {
      if (Number.isFinite(p)) {
        range.min = Math.min(range.min, p);
        range.max = Math.max(range.max, p);
      }
    }
    const span = range.max - range.min;
    const pad = Math.max(span * 0.04, range.max * 0.00005, 1e-8);
    return { priceRange: { minValue: range.min - pad, maxValue: range.max + pad } };
  }
  const res = original();
  if (res?.priceRange) {
    const pad = (res.priceRange.maxValue - res.priceRange.minValue) * 0.02;
    res.priceRange.minValue -= pad;
    res.priceRange.maxValue += pad;
  }
  return res;
}

function getVisibleBarsPriceRange(paddingPct = 0.06) {
  if (!state.lastCandles.length) return null;
  const logical = chart?.timeScale().getVisibleLogicalRange();
  let from = 0;
  let to = state.lastCandles.length;
  if (logical) {
    from = Math.max(0, Math.floor(logical.from));
    to = Math.min(state.lastCandles.length, Math.ceil(logical.to) + 1);
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = from; i < to; i++) {
    const c = state.lastCandles[i];
    if (!c) continue;
    min = Math.min(min, c.low);
    max = Math.max(max, c.high);
  }
  if (!isFinite(min) || !isFinite(max)) return null;
  const span = max - min;
  const pad = Math.max(span * paddingPct, max * 0.00005, 1e-8);
  return { min: min - pad, max: max + pad };
}

function captureVisiblePriceRange() {
  if (!chart || !candleSeries) return null;
  try {
    const height = chart.paneSize(0)?.height || $('#chartArea').clientHeight * 0.75;
    const topPrice = candleSeries.coordinateToPrice(0);
    const bottomPrice = candleSeries.coordinateToPrice(Math.max(height, 1));
    if (topPrice == null || bottomPrice == null) return null;
    return {
      min: Math.min(topPrice, bottomPrice),
      max: Math.max(topPrice, bottomPrice),
    };
  } catch {
    return null;
  }
}

function ensureLiveOhlcOverlay() {
  const main = document.querySelector('.chart-main');
  if (!main) return null;
  let el = document.getElementById('chartLiveOhlc');
  if (!el) {
    el = document.createElement('div');
    el.id = 'chartLiveOhlc';
    el.className = 'chart-live-ohlc';
    el.setAttribute('aria-live', 'polite');
    main.appendChild(el);
  }
  let badge = document.getElementById('chartDataSource');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'chartDataSource';
    badge.className = 'chart-data-source';
    main.appendChild(badge);
  }
  badge.textContent = isTradingPage ? 'Binance Futures' : 'Binance Spot';
  return el;
}

function updateLiveOhlcDisplay(candle) {
  if (!candle) return;
  const el = ensureLiveOhlcOverlay();
  if (!el) return;
  const chg = candle.close - candle.open;
  const chgPct = candle.open ? (chg / candle.open) * 100 : 0;
  const dir = chg >= 0 ? 'up' : 'down';
  el.className = `chart-live-ohlc chart-live-ohlc--${dir}`;
  el.innerHTML = [
    `<span>O <b>${formatPrice(candle.open)}</b></span>`,
    `<span>H <b>${formatPrice(candle.high)}</b></span>`,
    `<span>L <b>${formatPrice(candle.low)}</b></span>`,
    `<span>C <b>${formatPrice(candle.close)}</b></span>`,
    `<span class="chart-live-ohlc__chg">${chg >= 0 ? '+' : ''}${chgPct.toFixed(2)}%</span>`,
  ].join('');
}

function getVisibleCandlesPriceRange() {
  if (!state.lastCandles.length) return { min: 0, max: 1 };
  const captured = captureVisiblePriceRange();
  if (captured) return captured;
  return getVisibleBarsPriceRange(0.05) || { min: 0, max: 1 };
}

function resetManualPriceScale() {
  resetPriceScaleToAuto();
}

const TV_COLORS = {
  bg: '#131722',
  text: '#d1d4dc',
  grid: '#1e222d',
  border: '#2a2e39',
  up: '#0ecb81',
  down: '#f6465d',
  crosshair: '#758696',
  volumeUp: 'rgba(14, 203, 129, 0.45)',
  volumeDown: 'rgba(246, 70, 93, 0.45)',
  line: '#f0b90b',
};

function initChart(container) {
  if (chart) {
    chart.remove();
    chart = candleSeries = lineSeries = volumeSeries = null;
    swingHighPriceLine = swingLowPriceLine = null;
    swingStopPriceLine = null;
    backtestSlSegments = [];
    backtestTpSegments = [];
    signalOverlay = null;
    chartInitialized = false;
  }

  chart = LightweightCharts.createChart(container, {
    layout: {
      background: { type: 'solid', color: TV_COLORS.bg },
      textColor: TV_COLORS.text,
      fontFamily: "'Inter', -apple-system, sans-serif",
      fontSize: 12,
    },
    grid: {
      vertLines: { color: TV_COLORS.grid },
      horzLines: { color: TV_COLORS.grid },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: TV_COLORS.crosshair, width: 1, style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: TV_COLORS.border },
      horzLine: { color: TV_COLORS.crosshair, width: 1, style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: TV_COLORS.border },
    },
    rightPriceScale: {
      borderColor: TV_COLORS.border,
      scaleMargins: { top: 0.05, bottom: 0.25 },
      autoScale: true,
    },
    timeScale: {
      borderColor: TV_COLORS.border,
      timeVisible: true,
      secondsVisible: state.interval === '1m' || state.interval === '5m',
      barSpacing: 8,
      minBarSpacing: 2,
      rightOffset: 5,
      fixLeftEdge: false,
      lockVisibleTimeRangeOnResize: false,
      shiftVisibleRangeOnNewBar: true,
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
    },
    handleScale: {
      axisPressedMouseMove: { time: true, price: true },
      axisDoubleClickReset: { time: true, price: true },
      mouseWheel: true,
      pinch: true,
    },
    kineticScroll: { mouse: true, touch: true },
    width: container.clientWidth,
    height: Math.max(document.querySelector('.chart-workspace')?.clientHeight || 280, 200),
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: TV_COLORS.up,
    downColor: TV_COLORS.down,
    borderVisible: false,
    wickUpColor: TV_COLORS.up,
    wickDownColor: TV_COLORS.down,
    priceLineVisible: true,
    lastValueVisible: true,
    autoscaleInfoProvider: candleAutoscaleProvider,
  });

  lineSeries = chart.addLineSeries({
    color: TV_COLORS.line,
    lineWidth: 2,
    crosshairMarkerRadius: 4,
    crosshairMarkerBorderColor: TV_COLORS.line,
    visible: false,
    priceLineVisible: true,
    lastValueVisible: true,
    autoscaleInfoProvider: candleAutoscaleProvider,
  });

  volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
  });

  chart.priceScale('volume').applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 },
  });

  if (resizeObserver) resizeObserver.disconnect();
  const mainEl = container.parentElement;
  const workspace = mainEl?.closest('.chart-workspace') || mainEl;
  resizeObserver = new ResizeObserver(() => {
    if (chart && container.clientWidth > 0) {
      if (typeof IndicatorManager !== 'undefined') IndicatorManager.onResize();
      const h = workspace?.clientHeight || mainEl?.clientHeight || 280;
      chart.applyOptions({ width: container.clientWidth, height: h });
      if (typeof DrawingManager !== 'undefined') DrawingManager.redraw();
      updatePositionOverlayLabels();
    }
  });
  resizeObserver.observe(workspace || mainEl || container);
  chartInitialized = true;
  ensureLiveOhlcOverlay();
  setupChartInteractions();
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => updatePositionOverlayLabels());
  renderPositionOverlaySegments();
  applySwingLevelLines();
  applyStopLossLine();

  if (typeof IndicatorManager !== 'undefined') {
    IndicatorManager.init(chart, candleSeries);
    if (state.lastCandles.length) IndicatorManager.update(state.lastCandles);
  }
  if (typeof DrawingManager !== 'undefined') {
    DrawingManager.init(chart, candleSeries, mainEl || container);
  }
}

function setFollowingRealtime(following) {
  state.isFollowingRealtime = following;
  if (chart) {
    chart.timeScale().applyOptions({ shiftVisibleRangeOnNewBar: following });
  }
  $('#goRealtimeBtn')?.classList.toggle('hidden', following);
}

function scrollToRealtimeView() {
  if (!chart || !state.lastCandles.length) return;
  resetPriceScaleToAuto();
  state.programmaticScroll = true;
  chart.timeScale().scrollToRealTime();
  state.programmaticScroll = false;
  setFollowingRealtime(true);
}

function setupChartInteractions() {
  if (!chart) return;

  chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (state.programmaticScroll || !range || state.dragging) return;
    const barCount = state.lastCandles.length;
    if (!barCount) return;
    setFollowingRealtime(range.to >= barCount - 5);
    if (range.from < 40 && state.canLoadMore && !state.loadingMore) {
      scheduleLoadMoreCandles();
    }
  });

  if (panningSetup) return;
  panningSetup = true;

  const container = $('#chartArea');
  if (!container) return;
  container.style.touchAction = 'none';

  // Track active pointer for indicator deferral only — do not capture
  // or custom-pan. Native Lightweight Charts handles Binance/TV gestures.
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    if (typeof DrawingManager !== 'undefined' && DrawingManager.isDrawingMode()) return;
    state.dragging = true;
    container.classList.add('chart-area--dragging');
  };

  const onPointerEnd = () => {
    if (!state.dragging) return;
    state.dragging = false;
    container.classList.remove('chart-area--dragging');
    scheduleLiveIndicatorUpdate();
  };

  container.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);

  container.addEventListener('dblclick', (e) => {
    if (typeof DrawingManager !== 'undefined' && DrawingManager.isDrawingMode()) return;
    e.preventDefault();
    resetPriceScaleToAuto();
  });
}

function syncVolumeVisibility() {
  if (!volumeSeries) return;
  const hideMainVol = typeof IndicatorManager !== 'undefined'
    && (IndicatorManager.active.has('vol') || IndicatorManager.active.has('volma'));
  const isCandle = state.chartType === 'candlestick';
  volumeSeries.applyOptions({ visible: isCandle && !hideMainVol });
}

function setChartType(type) {
  if (!candleSeries || !lineSeries || !volumeSeries) return;
  const isCandle = type === 'candlestick';
  candleSeries.applyOptions({ visible: isCandle });
  lineSeries.applyOptions({ visible: !isCandle });
  syncVolumeVisibility();
}

function getVisibleBarCount() {
  const counts = { '1m': 180, '5m': 150, '15m': 120, '1h': 100, '4h': 80, '1d': 60 };
  return counts[state.interval] || 100;
}

function fitChartToSymbol(candles) {
  if (!chart || !candles.length) return;

  resetManualPriceScale();
  chart.priceScale('right').applyOptions({ autoScale: true });

  const barCount = candles.length;
  const visible = Math.min(getVisibleBarCount(), barCount);
  state.programmaticScroll = true;
  chart.timeScale().setVisibleLogicalRange({
    from: barCount - visible,
    to: barCount + 2,
  });
  chart.timeScale().scrollToRealTime();
  state.programmaticScroll = false;
  setFollowingRealtime(true);
}

function applyCandleData(candles, resetView = false) {
  if (!candleSeries || !candles.length) return;

  const intervalSec = INTERVALS[state.interval].seconds;
  const filled = sanitizeCandleSeries(fillCandleGaps(candles, intervalSec));
  if (!filled.length) return;
  state.lastCandles = filled;

  const candleData = filled.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
  const lineData = filled.map(({ time, close }) => ({ time, value: close }));
  const volData = filled.map(({ time, open, close, volume }) => ({
    time,
    value: volume,
    color: close >= open ? TV_COLORS.volumeUp : TV_COLORS.volumeDown,
  }));

  if (resetView) {
    clearSignalOverlay();
    clearPositionOverlay();
    candleSeries.setData([]);
    lineSeries.setData([]);
    volumeSeries.setData([]);
  }

  candleSeries.setData(candleData);
  lineSeries.setData(lineData);
  volumeSeries.setData(volData);

  const lastCandle = filled[filled.length - 1];
  state.formingCandleTime = lastCandle?.time ?? null;

  if (resetView) {
    requestAnimationFrame(() => fitChartToSymbol(filled));
  }
  // Do not scrollToRealTime on setData refresh — live updates use
  // series.update() + shiftVisibleRangeOnNewBar; forced scroll here (and from
  // backtest SL/TP refresh) was snapping the view backward on new bars.

  if (typeof IndicatorManager !== 'undefined') IndicatorManager.update(filled);
  syncVolumeVisibility();

  if (lastCandle) updateLiveOhlcDisplay(lastCandle);
  renderPositionOverlaySegments();

  document.dispatchEvent(new CustomEvent('chart-candles-updated', {
    detail: { candles: filled, interval: state.interval, symbol: state.binanceSymbol },
  }));
}

function flashPrice(el, direction) {
  if (!el) return;
  el.classList.remove('price-flash-up', 'price-flash-down');
  void el.offsetWidth;
  el.classList.add(direction === 'up' ? 'price-flash-up' : 'price-flash-down');
}

function updateLivePrice(symbol, price, changePct, ticker) {
  const idx = state.coins.findIndex((c) => {
    const base = c.symbol?.toUpperCase();
    return base && symbol === `${base}USDT`;
  });

  if (idx >= 0) {
    const prev = state.coins[idx].current_price;
    state.coins[idx].current_price = price;
    if (changePct != null) state.coins[idx].price_change_percentage_24h = changePct;

    const item = document.querySelector(`.coin-item[data-id="${state.coins[idx].id}"]`);
    if (item) {
      const priceEl = item.querySelector('.coin-item__price');
      const changeEl = item.querySelector('.coin-item__change');
      if (priceEl) {
        priceEl.textContent = formatPrice(price);
        if (prev != null && price !== prev) flashPrice(priceEl, price > prev ? 'up' : 'down');
      }
      if (changeEl && changePct != null) {
        changeEl.textContent = formatChange(changePct);
        changeEl.className = 'coin-item__change ' + changeClass(changePct);
      }
    }
  }

  if (state.binanceSymbol === symbol && state.selectedCoin) {
    const headerPrice = $('#currentPrice');
    const prevHeader = parseFloat(headerPrice.dataset.lastPrice || '0');
    headerPrice.textContent = formatPrice(price);
    headerPrice.dataset.lastPrice = price;
    if (prevHeader && price !== prevHeader) flashPrice(headerPrice, price > prevHeader ? 'up' : 'down');

    if (changePct != null) {
      const changeEl = $('#priceChange');
      changeEl.textContent = formatChange(changePct);
      changeEl.className = 'coin-header__change ' + changeClass(changePct);
    }

    if (ticker) {
      $('#high24h').textContent = formatPrice(parseFloat(ticker.h));
      $('#low24h').textContent = formatPrice(parseFloat(ticker.l));
      $('#volume24h').textContent = formatCompact(parseFloat(ticker.q));
    }
  }
}

function getCandleOpenTime(tsMs, intervalSec) {
  const ts = Math.floor(tsMs / 1000);
  return Math.floor(ts / intervalSec) * intervalSec;
}

function getIntervalSeconds() {
  return INTERVALS[state.interval].seconds;
}

function applyPriceFormat(price) {
  if (!candleSeries || price == null) return;
  let precision = 2;
  let minMove = 0.01;
  if (price < 0.0001) { precision = 8; minMove = 0.00000001; }
  else if (price < 0.01) { precision = 6; minMove = 0.000001; }
  else if (price < 1) { precision = 5; minMove = 0.00001; }
  else if (price < 100) { precision = 4; minMove = 0.0001; }

  const fmt = { type: 'price', precision, minMove };
  candleSeries.applyOptions({ priceFormat: fmt });
  lineSeries.applyOptions({ priceFormat: fmt });
}

function flushLiveIndicatorUpdate(newBar) {
  if (!state.lastCandles.length) return;
  lastLiveIndicatorAt = performance.now();
  liveIndicatorNeedsNewBar = false;

  document.dispatchEvent(new CustomEvent('chart-candle-tick', {
    detail: {
      candles: state.lastCandles,
      interval: state.interval,
      symbol: state.binanceSymbol,
      newBar,
    },
  }));
}

function scheduleLiveIndicatorUpdate(newBar = false) {
  if (!state.lastCandles.length) return;
  if (newBar) liveIndicatorNeedsNewBar = true;

  // Defer indicator recomputation while the user is actively dragging so the
  // pan stays smooth; the pending work is flushed as soon as the drag ends.
  if (state.dragging) return;

  const now = performance.now();
  const elapsed = now - lastLiveIndicatorAt;
  const pendingNewBar = liveIndicatorNeedsNewBar;

  if (pendingNewBar || elapsed >= LIVE_INDICATOR_MS) {
    if (liveIndicatorTimer) {
      clearTimeout(liveIndicatorTimer);
      liveIndicatorTimer = null;
    }
    flushLiveIndicatorUpdate(pendingNewBar);
    return;
  }

  if (liveIndicatorTimer) return;
  liveIndicatorTimer = setTimeout(() => {
    liveIndicatorTimer = null;
    flushLiveIndicatorUpdate(liveIndicatorNeedsNewBar);
  }, LIVE_INDICATOR_MS - elapsed);
}

function renderFormingCandle(candle, options) {
  renderCandleImmediate(candle, options);
}

function renderCandleImmediate(candle, { newBar = false } = {}) {
  if (!candleSeries) return;
  const entry = { time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close };
  const isUp = candle.close >= candle.open;

  candleSeries.update(entry);
  lineSeries?.update({ time: candle.time, value: candle.close });
  volumeSeries.update({
    time: candle.time,
    value: candle.volume,
    color: isUp ? TV_COLORS.volumeUp : TV_COLORS.volumeDown,
  });
  updateLiveOhlcDisplay(candle);

  if (state.dragging) return;

  candleSeries.applyOptions({
    priceLineColor: isUp ? TV_COLORS.up : TV_COLORS.down,
  });
  lineSeries?.applyOptions({
    color: isUp ? TV_COLORS.up : TV_COLORS.down,
    priceLineColor: isUp ? TV_COLORS.up : TV_COLORS.down,
  });

  if (typeof IndicatorManager !== 'undefined' && IndicatorManager.updateLive) {
    IndicatorManager.updateLive(state.lastCandles, { newBar });
  }

  // No explicit scrollToRealTime here: while following, the time scale's
  // shiftVisibleRangeOnNewBar keeps the newest bar in view natively. The old
  // animated scroll on every kline update yanked the view backward whenever
  // the user had panned or zoomed (TradingView/Binance never do this).

  scheduleLiveIndicatorUpdate(newBar);
  renderPositionOverlaySegments();
}

function createNewFormingCandle(time, openPrice) {
  return {
    time,
    open: openPrice,
    high: openPrice,
    low: openPrice,
    close: openPrice,
    volume: 0,
  };
}

/** Apply an exchange kline bar (authoritative OHLCV). */
function applyExchangeKline(candle, isClosed) {
  if (!candleSeries || !candle) return;
  const intervalSec = getIntervalSeconds();
  const lastIdx = state.lastCandles.length - 1;
  const last = state.lastCandles[lastIdx];

  if (!last) {
    state.lastCandles.push({ ...candle });
    state.formingCandleTime = isClosed ? null : candle.time;
    renderFormingCandle(candle, { newBar: true });
    return;
  }

  if (candle.time === last.time) {
    let high = candle.high;
    let low = candle.low;
    let close = candle.close;
    if (
      !isClosed
      && state.lastTickPrice != null
      && state.lastTickTime > candle.time * 1000
      && getCandleOpenTime(state.lastTickTime, intervalSec) === candle.time
    ) {
      high = Math.max(high, state.lastTickPrice);
      low = Math.min(low, state.lastTickPrice);
      close = state.lastTickPrice;
    }
    const updated = {
      time: candle.time,
      open: candle.open,
      high,
      low,
      close: isClosed ? candle.close : close,
      volume: candle.volume,
    };
    state.lastCandles[lastIdx] = updated;
    state.formingCandleTime = isClosed ? null : candle.time;
    renderFormingCandle(updated, { newBar: isClosed });
    return;
  }

  if (candle.time === last.time + intervalSec) {
    state.lastCandles.push({ ...candle });
    state.formingCandleTime = isClosed ? null : candle.time;
    renderFormingCandle(candle, { newBar: true });
    return;
  }

  if (candle.time > last.time + intervalSec) {
    scheduleCatchUp(`kline jump ${last.time} -> ${candle.time}`);
    return;
  }

  const idx = state.lastCandles.findIndex((c) => c.time === candle.time);
  if (idx < 0) {
    scheduleCatchUp(`kline missing past ${candle.time}`);
    return;
  }
  state.lastCandles[idx] = { ...candle };
  if (idx === state.lastCandles.length - 1) {
    state.formingCandleTime = isClosed ? null : candle.time;
    renderFormingCandle(candle, { newBar: isClosed });
  } else {
    replaceCandleSeriesData(state.lastCandles);
  }
}

/**
 * Apply a real trade. Only touches the current forming bar, or opens the
 * immediate next bar (first trade = open). Never skips intervals.
 */
function applyTradeToCandles(price, volumeDelta, tradeTimeMs) {
  if (!candleSeries || !state.lastCandles.length) return;
  if (!Number.isFinite(price) || price <= 0) return;

  state.lastTickPrice = price;
  state.lastTickTime = tradeTimeMs;
  updateHeaderPrice(price);

  const intervalSec = getIntervalSeconds();
  const candleTime = getCandleOpenTime(tradeTimeMs, intervalSec);
  const lastIdx = state.lastCandles.length - 1;
  const last = state.lastCandles[lastIdx];

  if (candleTime < last.time) {
    const idx = state.lastCandles.findIndex((c) => c.time === candleTime);
    if (idx < 0) return;
    const bar = state.lastCandles[idx];
    const updated = {
      ...bar,
      high: Math.max(bar.high, price),
      low: Math.min(bar.low, price),
      close: idx === lastIdx ? price : bar.close,
      volume: bar.volume + (volumeDelta || 0),
    };
    state.lastCandles[idx] = updated;
    if (idx === lastIdx) renderFormingCandle(updated);
    return;
  }

  if (candleTime === last.time) {
    const updated = {
      ...last,
      close: price,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      volume: last.volume + (volumeDelta || 0),
    };
    state.lastCandles[lastIdx] = updated;
    state.formingCandleTime = candleTime;
    renderFormingCandle(updated);
    return;
  }

  if (candleTime === last.time + intervalSec) {
    const next = {
      time: candleTime,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: volumeDelta || 0,
    };
    state.lastCandles.push(next);
    state.formingCandleTime = candleTime;
    renderFormingCandle(next, { newBar: true });
    return;
  }

  scheduleCatchUp(`trade jump ${last.time} -> ${candleTime}`);
}

function startCandleStaleWatch() {
  if (candleRolloverTimer) clearInterval(candleRolloverTimer);
  candleRolloverTimer = setInterval(() => {
    if (!state.lastCandles.length || !state.binanceSymbol) return;
    const intervalSec = getIntervalSeconds();
    const expected = getCandleOpenTime(Date.now(), intervalSec);
    const last = state.lastCandles[state.lastCandles.length - 1];
    if (expected - last.time > intervalSec) {
      scheduleCatchUp('stale watch');
    }
  }, 2000);
}

function stopCandleRolloverCheck() {
  if (candleRolloverTimer) {
    clearInterval(candleRolloverTimer);
    candleRolloverTimer = null;
  }
}

function pushCandleToState(candle) {
  const last = state.lastCandles[state.lastCandles.length - 1];
  if (!last || last.time !== candle.time) {
    state.lastCandles.push({ ...candle });
  } else {
    state.lastCandles[state.lastCandles.length - 1] = { ...candle };
  }
  state.formingCandleTime = candle.time;
}

function renderCandle(candle) {
  renderFormingCandle(candle);
}

function updateFormingCandle(price, volumeDelta = 0, tradeTimeMs = Date.now()) {
  queueLiveTick(price, volumeDelta, tradeTimeMs);
}

function queueLiveTick(price, volumeDelta = 0, tradeTimeMs = Date.now()) {
  if (!Number.isFinite(price) || price <= 0) return;

  const intervalSec = getIntervalSeconds();
  const candleTime = getCandleOpenTime(tradeTimeMs, intervalSec);

  if (pendingTick) {
    const pendingTime = getCandleOpenTime(pendingTick.timeMs, intervalSec);
    if (pendingTime !== candleTime) {
      flushLiveTick();
    }
  }

  if (pendingTick) {
    pendingTick.price = price;
    pendingTick.volumeDelta += volumeDelta;
    pendingTick.hi = Math.max(pendingTick.hi, price);
    pendingTick.lo = Math.min(pendingTick.lo, price);
    pendingTick.timeMs = Math.max(pendingTick.timeMs, tradeTimeMs);
  } else {
    pendingTick = { price, volumeDelta, hi: price, lo: price, timeMs: tradeTimeMs };
  }

  ensureLiveRenderLoop();
}

function ensureLiveRenderLoop() {
  if (liveRenderRaf != null) return;
  liveRenderRaf = requestAnimationFrame(flushLiveTick);
}

function flushLiveTick() {
  liveRenderRaf = null;
  const tick = pendingTick;
  if (!tick) return;
  pendingTick = null;

  if (!candleSeries || !state.lastCandles.length) return;

  const intervalSec = getIntervalSeconds();
  const candleTime = getCandleOpenTime(tick.timeMs, intervalSec);
  const last = state.lastCandles[state.lastCandles.length - 1];

  if (last && candleTime === last.time) {
    state.lastTickPrice = tick.price;
    state.lastTickTime = tick.timeMs;
    updateHeaderPrice(tick.price);
    const updated = {
      ...last,
      close: tick.price,
      high: Math.max(last.high, tick.hi, tick.price),
      low: Math.min(last.low, tick.lo, tick.price),
      volume: last.volume + tick.volumeDelta,
    };
    state.lastCandles[state.lastCandles.length - 1] = updated;
    state.formingCandleTime = candleTime;
    renderFormingCandle(updated);
    return;
  }

  applyTradeToCandles(tick.price, tick.volumeDelta, tick.timeMs);
  const after = state.lastCandles[state.lastCandles.length - 1];
  if (after && after.time === candleTime && (tick.hi > after.high || tick.lo < after.low)) {
    const updated = {
      ...after,
      high: Math.max(after.high, tick.hi),
      low: Math.min(after.low, tick.lo),
      close: tick.price,
    };
    state.lastCandles[state.lastCandles.length - 1] = updated;
    renderFormingCandle(updated);
  }
}

function stopLiveRenderLoop() {
  if (liveRenderRaf != null) {
    cancelAnimationFrame(liveRenderRaf);
    liveRenderRaf = null;
  }
  pendingTick = null;
}

function handleKlineEvent(k) {
  const candle = {
    time: Math.floor(k.t / 1000),
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low: parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v),
  };

  applyExchangeKline(candle, Boolean(k.x));
  updateHeaderPrice(candle.close);
}

// ── WebSocket real-time ─────────────────────────────────────

function closeWebSocket() {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  stopCandleRolloverCheck();
  stopLiveRenderLoop();
  $('#liveIndicator')?.classList.add('hidden');
}

function connectWebSocket(symbol, interval) {
  closeWebSocket();
  const s = symbol.toLowerCase();
  // kline = OHLC authority, trade = live wick/close. No bookTicker on candles.
  const streams = `${s}@kline_${interval}/${s}@trade`;
  ws = new WebSocket(`${BINANCE_WS}/stream?streams=${streams}`);

  ws.onopen = () => {
    $('#liveIndicator')?.classList.remove('hidden');
    startCandleStaleWatch();
    catchUpRecentCandles();
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const { stream, data } = msg;

    if (stream.includes('@kline')) {
      handleKlineEvent(data.k);
    } else if (stream.includes('@trade')) {
      const price = parseFloat(data.p);
      const qty = parseFloat(data.q);
      const timeMs = data.T || data.E || Date.now();
      updateFormingCandle(price, qty, timeMs);
    }

    const el = $('#lastUpdated');
    if (el) el.textContent = '실시간 · ' + new Date().toLocaleTimeString('ko-KR');
  };

  ws.onclose = () => {
    $('#liveIndicator')?.classList.add('hidden');
    if (state.binanceSymbol === symbol && state.interval === interval) {
      setTimeout(() => {
        if (state.binanceSymbol === symbol && state.interval === interval) {
          connectWebSocket(symbol, interval);
        }
      }, 2000);
    }
  };

  ws.onerror = () => { /* reconnect handled in onclose */ };
}

function connectMiniTickerStream() {
  if (miniTickerWs) return;

  miniTickerWs = new WebSocket(`${binanceWsSingleBase()}/!miniTicker@arr`);

  miniTickerWs.onmessage = (event) => {
    const tickers = JSON.parse(event.data);
    const symbolSet = new Set(
      state.coins.map((c) => {
        const base = c.symbol?.toUpperCase();
        return base ? `${base}USDT` : null;
      }).filter(Boolean)
    );

    for (const t of tickers) {
      if (!symbolSet.has(t.s)) continue;
      const price = parseFloat(t.c);
      const open = parseFloat(t.o);
      const changePct = open ? ((price - open) / open) * 100 : 0;
      updateLivePrice(t.s, price, changePct);

      if (state.binanceSymbol === t.s) { updateHeaderPrice(price); }
    }
  };

  miniTickerWs.onclose = () => {
    miniTickerWs = null;
    setTimeout(connectMiniTickerStream, 3000);
  };
}

// ── Formatting ──────────────────────────────────────────────

function formatPrice(value) {
  if (value == null) return '—';
  if (value >= 1) return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatCompact(value) {
  if (value == null) return '—';
  if (value >= 1e12) return '$' + (value / 1e12).toFixed(2) + 'T';
  if (value >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
  if (value >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
  return formatPrice(value);
}

function formatChange(pct) {
  if (pct == null) return '—';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function changeClass(pct) {
  if (pct == null) return '';
  return pct >= 0 ? 'positive' : 'negative';
}

// ── UI ────────────────────────────────────────────────────────

function renderCoinList() {
  const list = $('#coinList');
  list.innerHTML = state.coins.map((coin, i) => `
    <li class="coin-item ${state.selectedCoin?.id === coin.id ? 'active' : ''}" data-id="${coin.id}">
      <span class="coin-item__rank">${coin.market_cap_rank || i + 1}</span>
      ${coin.image ? `<img class="coin-item__icon" src="${coin.image}" alt="${coin.name}" loading="lazy">` : `<span class="coin-item__icon coin-item__icon--placeholder">${(coin.symbol || '?')[0].toUpperCase()}</span>`}
      <div class="coin-item__info">
        <div class="coin-item__name">${coin.name}</div>
        <div class="coin-item__symbol">${coin.symbol}</div>
      </div>
      <div class="coin-item__price-col">
        <div class="coin-item__price">${formatPrice(coin.current_price)}</div>
        <div class="coin-item__change ${changeClass(coin.price_change_percentage_24h)}">${formatChange(coin.price_change_percentage_24h)}</div>
      </div>
    </li>
  `).join('');

  list.querySelectorAll('.coin-item').forEach((el) => {
    el.addEventListener('click', () => selectCoin(el.dataset.id));
  });
}

function updateCoinHeader(coin, ticker) {
  const icon = $('#coinIcon');
  icon.src = coin.image;
  icon.alt = coin.name;
  icon.hidden = false;
  $('#coinName').textContent = coin.name;
  $('#coinSymbol').textContent = (coin.symbol?.toUpperCase() || '') + '/USDT';

  const price = ticker ? parseFloat(ticker.lastPrice) : coin.current_price;
  const change = ticker ? parseFloat(ticker.priceChangePercent) : coin.price_change_percentage_24h;

  $('#currentPrice').textContent = formatPrice(price);
  const changeEl = $('#priceChange');
  changeEl.textContent = formatChange(change);
  changeEl.className = 'coin-header__change ' + changeClass(change);

  if (ticker) {
    $('#high24h').textContent = formatPrice(parseFloat(ticker.highPrice));
    $('#low24h').textContent = formatPrice(parseFloat(ticker.lowPrice));
    $('#volume24h').textContent = formatCompact(parseFloat(ticker.quoteVolume));
  } else {
    $('#high24h').textContent = formatPrice(coin.high_24h);
    $('#low24h').textContent = formatPrice(coin.low_24h);
    $('#volume24h').textContent = formatCompact(coin.total_volume);
  }
  $('#marketCap').textContent = formatCompact(coin.market_cap);
}

function setLoading(isLoading) {
  $('#chartLoading').classList.toggle('hidden', !isLoading);
  if (isLoading) $('#chartError').classList.add('hidden');
  if (!isLoading) setLoadingProgress('차트 데이터 로딩 중...');
}

function setLoadingProgress(text) {
  const el = $('#chartLoading')?.querySelector('span');
  if (el) el.textContent = text || '차트 데이터 로딩 중...';
}

function scheduleLoadMoreCandles() {
  clearTimeout(loadMoreDebounce);
  loadMoreDebounce = setTimeout(() => { loadMoreHistoricalCandles(); }, 250);
}

async function loadMoreHistoricalCandles() {
  if (!window.KlineLoader || !state.binanceSymbol || state.loadingMore || !state.canLoadMore) return;
  if (!state.lastCandles.length) return;

  state.loadingMore = true;
  try {
    const beforeTime = state.lastCandles[0].time;
    const older = await KlineLoader.fetchOlder(
      state.binanceSymbol,
      state.interval,
      beforeTime,
      (url) => fetchWithCache(url, 5_000),
    );

    if (!older.length || older.length < 50) {
      state.canLoadMore = false;
      return;
    }

    const merged = KlineLoader.mergeCandles(state.lastCandles, older);
    if (merged.length === state.lastCandles.length) {
      state.canLoadMore = false;
      return;
    }

    const added = merged.length - state.lastCandles.length;
    const visibleRange = chart?.timeScale().getVisibleLogicalRange();
    const wasAuto = isPriceScaleAuto();
    applyCandleData(merged, false);

    if (!wasAuto) {
      chart.priceScale('right').applyOptions({ autoScale: false });
    }

    if (visibleRange && chart) {
      state.programmaticScroll = true;
      chart.timeScale().setVisibleLogicalRange({
        from: visibleRange.from + added,
        to: visibleRange.to + added,
      });
      state.programmaticScroll = false;
    }

    if (merged.length >= MAX_CHART_BARS || older.length < KlineLoader.PAGE_SIZE / 2) {
      state.canLoadMore = false;
    }
  } catch (err) {
    console.warn('Load more candles failed:', err);
  } finally {
    state.loadingMore = false;
  }
}

async function loadHistoryUntilTime(targetTime, maxPages = 12) {
  if (!Number.isFinite(targetTime) || !state.lastCandles.length) return false;
  let pages = 0;
  while (state.lastCandles[0].time > targetTime && state.canLoadMore && pages < maxPages) {
    await loadMoreHistoricalCandles();
    pages += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return state.lastCandles[0].time <= targetTime;
}

function showError(message) {
  $('#chartError').classList.remove('hidden');
  const text = (message && String(message).trim()) || '차트를 불러오지 못했습니다.';
  $('#chartError').querySelector('p').textContent = text;
  $('#chartLoading').classList.add('hidden');
  closeWebSocket();
}

// ── Chart loading ─────────────────────────────────────────────

async function loadChart(retryCount = 0) {
  if (!state.selectedCoin) return;
  setLoading(true);
  closeWebSocket();

  try {
    const symbol = await resolveBinanceSymbol(state.selectedCoin);
    if (!symbol) {
      showError(`${state.selectedCoin.name}은(는) Binance USDT 마켓에서 지원되지 않습니다.`);
      return;
    }
    state.binanceSymbol = symbol;
    state.lastTickPrice = null;
    state.lastTickTime = 0;
    state.canLoadMore = true;
    state.loadingMore = false;

    const container = $('#chartArea');
    await waitForContainer(container);
    if (!chartInitialized) initChart(container);

    const { targetBars } = INTERVALS[state.interval];
    const fetchJson = (url) => fetchWithCache(url, 5_000);
    const candlesPromise = window.KlineLoader
      ? KlineLoader.fetchHistorical(symbol, state.interval, targetBars, fetchJson, ({ candles, target }) => {
        setLoadingProgress(`차트 데이터 로딩 중... ${candles.toLocaleString()} / ${target.toLocaleString()}봉`);
      })
      : fetchKlines(symbol, state.interval, targetBars);

    const [candles, ticker] = await Promise.all([
      candlesPromise,
      fetch24hTicker(symbol),
    ]);

    applyCandleData(candles, true);
    applyPriceFormat(parseFloat(ticker.lastPrice) || candles[candles.length - 1]?.close);
    updateCoinHeader(state.selectedCoin, ticker);
    setChartType(state.chartType);
    connectWebSocket(symbol, state.interval);

    setLoading(false);
    const updated = $('#lastUpdated');
    if (updated) updated.textContent = '실시간 · ' + new Date().toLocaleTimeString('ko-KR');
  } catch (err) {
    console.error('Chart load error:', err);
    if (retryCount < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (retryCount + 1)));
      return loadChart(retryCount + 1);
    }
    showError(err?.message || String(err));
  }
}

async function selectCoin(coinId) {
  const coin = state.coins.find((c) => c.id === coinId);
  if (!coin || state.selectedCoin?.id === coinId) return;
  state.selectedCoin = coin;
  updateCoinHeader(coin);
  renderCoinList();
  await loadChart();
}

async function initTradingChart() {
  try {
    if (window.KlineLoader?.setMarket) {
      KlineLoader.setMarket('futures');
    }
    await loadBinanceSymbols();
    const btc = {
      id: 'bitcoin',
      name: 'Bitcoin',
      symbol: 'btc',
      image: 'https://assets.coingecko.com/coins/images/1/small/bitcoin.png',
      current_price: 0,
      price_change_percentage_24h: 0,
      high_24h: 0,
      low_24h: 0,
      total_volume: 0,
      market_cap: null,
    };
    state.coins = [btc];
    state.selectedCoin = btc;
    updateCoinHeader(btc);
    await loadChart();
  } catch (err) {
    console.error('Trading chart init error:', err);
    showError(err?.message || String(err));
  }
}

async function init() {
  bindVisibilityCatchUp();
  if (isTradingPage) {
    await initTradingChart();
    return;
  }
  try {
    await loadBinanceSymbols();
    connectMiniTickerStream();
    state.coins = await fetchTopCoinsFromBinance();
    renderCoinList();
    const defaultCoin = state.coins.find((c) => c.symbol === 'btc') || state.coins[0];
    if (defaultCoin) await selectCoin(defaultCoin.id);

    fetchTopCoins(30).then((coins) => {
      if (coins?.length) {
        state.coins = coins;
        renderCoinList();
      }
    }).catch(() => {});
  } catch (err) {
    console.error('Init error:', err);
    $('#coinList').innerHTML = '<li class="coin-list__loading">데이터를 불러오지 못했습니다. 새로고침해주세요.</li>';
  }
}

// ── Event listeners ───────────────────────────────────────────

let searchTimeout;
$('#searchInput')?.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  const query = e.target.value.trim();
  const resultsEl = $('#searchResults');
  if (query.length < 2) { resultsEl.classList.add('hidden'); return; }

  searchTimeout = setTimeout(async () => {
    try {
      const results = await searchCoins(query);
      if (!results.length) {
        resultsEl.innerHTML = '<div class="search-results__item" style="cursor:default;color:var(--text-muted)">결과 없음</div>';
      } else {
        resultsEl.innerHTML = results.map((coin) => `
          <div class="search-results__item" data-id="${coin.id}" data-name="${coin.name}" data-symbol="${coin.symbol}" data-image="${coin.large || coin.thumb}">
            <img src="${coin.thumb}" alt="${coin.name}">
            <span class="search-results__name">${coin.name}</span>
            <span class="search-results__symbol">${coin.symbol}</span>
          </div>
        `).join('');

        resultsEl.querySelectorAll('.search-results__item[data-id]').forEach((el) => {
          el.addEventListener('click', async () => {
            let coin = state.coins.find((c) => c.id === el.dataset.id);
            if (!coin) {
              coin = { id: el.dataset.id, name: el.dataset.name, symbol: el.dataset.symbol, image: el.dataset.image };
              state.coins.unshift(coin);
            }
            await selectCoin(coin.id);
            resultsEl.classList.add('hidden');
            $('#searchInput').value = '';
          });
        });
      }
      resultsEl.classList.remove('hidden');
    } catch (err) {
      console.error('Search error:', err);
    }
  }, 300);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.header__search')) $('#searchResults')?.classList.add('hidden');
});

$$('[data-chart-type]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('[data-chart-type]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.chartType = btn.dataset.chartType;
    setChartType(state.chartType);
  });
});

$$('[data-interval]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    $$('[data-interval]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.interval = btn.dataset.interval;
    if (chart) {
      chart.applyOptions({
        timeScale: { secondsVisible: state.interval === '1m' || state.interval === '5m' },
      });
    }
    await loadChart();
  });
});

$('#refreshBtn')?.addEventListener('click', () => loadChart());
$('#retryBtn')?.addEventListener('click', () => loadChart());
$('#goRealtimeBtn')?.addEventListener('click', () => scrollToRealtimeView());

$('#indicatorBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  $('#indicatorMenu')?.classList.toggle('hidden');
});

$('#drawingToggleBtn')?.addEventListener('click', () => {
  const bar = $('#drawingToolbar');
  const overlay = $('#drawingOverlay');
  if (!bar || !overlay) return;
  bar.classList.toggle('hidden');
  const on = !bar.classList.contains('hidden');
  overlay.classList.toggle('hidden', !on);
  if (typeof DrawingManager !== 'undefined') {
    DrawingManager.setEnabled(on);
    if (!on) DrawingManager.setMode('cursor');
  }
});

document.addEventListener('indicators-changed', () => syncVolumeVisibility());

document.addEventListener('click', (e) => {
  if (!e.target.closest('.indicator-dropdown')) {
    $('#indicatorMenu')?.classList.add('hidden');
  }
});

window.addEventListener('beforeunload', () => {
  closeWebSocket();
  stopCandleRolloverCheck();
  if (miniTickerWs) {
    miniTickerWs.onclose = null;
    miniTickerWs.close();
  }
});

async function selectCoinByQuery(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return false;

  const aliases = {
    btc: 'bitcoin', 비트: 'bitcoin', 비트코인: 'bitcoin', bitcoin: 'bitcoin',
    eth: 'ethereum', 이더: 'ethereum', 이더리움: 'ethereum', ethereum: 'ethereum',
    sol: 'solana', 솔: 'solana', 솔라나: 'solana', solana: 'solana',
    xrp: 'ripple', 리플: 'ripple', ripple: 'ripple',
    doge: 'dogecoin', 도지: 'dogecoin', dogecoin: 'dogecoin',
    ada: 'cardano', 카르다노: 'cardano', cardano: 'cardano',
    bnb: 'binancecoin', 바이낸스: 'binancecoin', binancecoin: 'binancecoin',
  };

  const coinId = aliases[q] || q;
  let coin = state.coins.find((c) =>
    c.id === coinId || c.symbol === coinId || c.name.toLowerCase() === coinId
  );

  if (!coin) {
    try {
      const results = await searchCoins(coinId);
      if (results.length) {
        const r = results[0];
        coin = state.coins.find((c) => c.id === r.id) || {
          id: r.id,
          name: r.name,
          symbol: r.symbol,
          image: r.large || r.thumb,
        };
        if (!state.coins.find((c) => c.id === coin.id)) state.coins.unshift(coin);
      }
    } catch { /* ignore */ }
  }

  if (!coin) return false;
  await selectCoin(coin.id);
  return true;
}

async function setChartInterval(interval) {
  if (!INTERVALS[interval]) return false;
  state.interval = interval;
  $$('[data-interval]').forEach((b) => {
    b.classList.toggle('active', b.dataset.interval === interval);
  });
  if (chart) {
    chart.applyOptions({
      timeScale: { secondsVisible: interval === '1m' || interval === '5m' },
    });
  }
  await loadChart();
  return true;
}

function clearStopLossLine() {
  if (candleSeries && swingStopPriceLine) {
    candleSeries.removePriceLine(swingStopPriceLine);
    swingStopPriceLine = null;
  }
}

function applyStopLossLine() {
  clearStopLossLine();
  if (!candleSeries || pendingStopLossPrice == null) return;
  swingStopPriceLine = candleSeries.createPriceLine({
    price: pendingStopLossPrice,
    color: '#ff9800',
    lineWidth: 2,
    lineStyle: 2,
    axisLabelVisible: true,
    title: '손절',
  });
}

function setStopLossLine(price) {
  pendingStopLossPrice = price;
  applyStopLossLine();
}

function clearSwingLevelLines() {
  if (candleSeries && swingHighPriceLine) {
    candleSeries.removePriceLine(swingHighPriceLine);
    swingHighPriceLine = null;
  }
  if (candleSeries && swingLowPriceLine) {
    candleSeries.removePriceLine(swingLowPriceLine);
    swingLowPriceLine = null;
  }
}

function applySwingLevelLines() {
  clearSwingLevelLines();
  if (!candleSeries || !pendingSwingLevels) return;

  const { swingHigh, swingLow } = pendingSwingLevels;
  if (swingHigh != null) {
    swingHighPriceLine = candleSeries.createPriceLine({
      price: swingHigh,
      color: '#ef5350',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: '전고점',
    });
  }
  if (swingLow != null) {
    swingLowPriceLine = candleSeries.createPriceLine({
      price: swingLow,
      color: '#26a69a',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: '전저점',
    });
  }
}

function setSwingLevelLines(levels) {
  pendingSwingLevels = levels;
  applySwingLevelLines();
}

// Live entry-signal overlay: dashed lines for the pending signal's entry, stop
// loss (red) and take profit (green) — same dashed convention as the backtest
// trade overlays. Lines are reused in place across ticks (only rebuilt when the
// signal appears/disappears or flips direction) to avoid per-frame flicker.
function clearSignalOverlay() {
  if (candleSeries && signalOverlay) {
    for (const pl of [signalOverlay.entry, signalOverlay.stop, signalOverlay.tp]) {
      if (pl) { try { candleSeries.removePriceLine(pl); } catch { /* ignore */ } }
    }
  }
  signalOverlay = null;
}

function setSignalOverlay(signal) {
  if (!candleSeries || !signal) { clearSignalOverlay(); return; }
  const { side, entryPrice, stopPrice, takeProfitPrice } = signal;
  if (side !== 'LONG' && side !== 'SHORT') { clearSignalOverlay(); return; }
  const buy = side === 'LONG';

  // Same direction already drawn → just move the existing lines.
  if (signalOverlay && signalOverlay.side === side) {
    if (signalOverlay.entry && Number.isFinite(entryPrice)) signalOverlay.entry.applyOptions({ price: entryPrice });
    if (signalOverlay.stop && Number.isFinite(stopPrice)) signalOverlay.stop.applyOptions({ price: stopPrice });
    if (signalOverlay.tp && Number.isFinite(takeProfitPrice)) signalOverlay.tp.applyOptions({ price: takeProfitPrice });
    return;
  }

  clearSignalOverlay();
  signalOverlay = { side, entry: null, stop: null, tp: null };

  if (Number.isFinite(entryPrice)) {
    signalOverlay.entry = candleSeries.createPriceLine({
      price: entryPrice,
      color: buy ? '#2962ff' : '#f7931a',
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: buy ? '매수 신호' : '매도 신호',
    });
  }
  if (Number.isFinite(stopPrice)) {
    signalOverlay.stop = candleSeries.createPriceLine({
      price: stopPrice,
      color: '#ef5350',
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: '신호 손절',
    });
  }
  if (Number.isFinite(takeProfitPrice)) {
    signalOverlay.tp = candleSeries.createPriceLine({
      price: takeProfitPrice,
      color: '#26a69a',
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: '신호 익절',
    });
  }
}

// Open-position overlay: left-side labels + SVG dashed lines (Binance projection style).
function renderPositionOverlaySegments() {
  if (!positionOverlayPending || !chart || !state.lastCandles?.length) {
    updatePositionOverlayLabels();
    return;
  }

  // Remove legacy line-series overlays; dashed lines are drawn via SVG from labels.
  if (chart) {
    for (const s of [positionSlSeries, positionTpSeries, positionEntrySeries]) {
      if (s) { try { chart.removeSeries(s); } catch { /* ignore */ } }
    }
  }
  positionSlSeries = positionTpSeries = positionEntrySeries = null;

  if (candleSeries && isPriceScaleAuto()) {
    candleSeries.applyOptions({ autoscaleInfoProvider: candleAutoscaleProvider });
  }
  updatePositionOverlayLabels();
}

// Binance long/short position projection: labels on the left, dashed lines
// extending rightward at each price level (no filled zones).
function ensurePositionLabelWrap() {
  const main = document.querySelector('.chart-main');
  if (!main) return null;
  let wrap = document.getElementById('chartPositionLabels');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'chartPositionLabels';
    wrap.className = 'chart-position-labels';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'pos-projection-lines');
    svg.setAttribute('aria-hidden', 'true');
    for (const role of ['tp', 'entry', 'sl']) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', `pos-projection-line pos-projection-line--${role}`);
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-dasharray', '6 4');
      line.setAttribute('visibility', 'hidden');
      svg.appendChild(line);
    }
    wrap.appendChild(svg);
    for (const role of ['tp', 'entry', 'sl']) {
      const el = document.createElement('div');
      el.className = `pos-projection-label pos-projection-label--${role}`;
      el.dataset.role = role;
      if (role === 'sl' || role === 'tp') el.dataset.dragRole = role;
      wrap.appendChild(el);
    }
    for (const role of ['sl', 'tp']) {
      const hit = document.createElement('div');
      hit.className = `pos-projection-hit pos-projection-hit--${role}`;
      hit.dataset.dragRole = role;
      hit.title = '드래그하여 가격 조정';
      wrap.appendChild(hit);
    }
    bindPositionLabelDrag(wrap);
    main.appendChild(wrap);
  }
  return wrap;
}

function layoutPositionHitStrip(wrap, role, price, chartWidth, paneHeight) {
  const hit = wrap?.querySelector(`.pos-projection-hit--${role}`);
  if (!hit) return;
  const y = candleSeries?.priceToCoordinate(price);
  if (!Number.isFinite(price) || y == null || y < -24 || y > paneHeight + 24) {
    hit.style.display = 'none';
    return;
  }
  hit.style.display = 'block';
  hit.style.top = `${y}px`;
  hit.style.width = `${chartWidth}px`;
}

function layoutPositionLabelRow(el, lineEl, price, strokeColor, chartWidth, paneHeight) {
  if (!el) return;
  const y = candleSeries?.priceToCoordinate(price);
  if (!Number.isFinite(price) || y == null || y < -24 || y > paneHeight + 24) {
    el.style.display = 'none';
    if (lineEl) lineEl.setAttribute('visibility', 'hidden');
    return;
  }

  const labelLeft = 4;
  el.style.display = 'block';
  el.style.left = `${labelLeft}px`;
  el.style.top = `${y}px`;

  if (!lineEl) return;
  const x1 = labelLeft + el.offsetWidth + 4;
  const x2 = Math.max(x1 + 12, chartWidth - 6);
  lineEl.setAttribute('x1', String(x1));
  lineEl.setAttribute('y1', String(y));
  lineEl.setAttribute('x2', String(x2));
  lineEl.setAttribute('y2', String(y));
  lineEl.setAttribute('stroke', strokeColor);
  lineEl.setAttribute('visibility', 'visible');
}

function updatePositionOverlayLabels() {
  const wrap = ensurePositionLabelWrap();
  if (!wrap) return;
  if (!positionOverlayPending || !chart || !candleSeries || !state.lastCandles?.length) {
    wrap.style.display = 'none';
    return;
  }

  const { side, entryPrice, stopPrice, takeProfitPrice, showEntry = true } = positionOverlayPending;
  const ts = chart.timeScale();
  const chartWidth = ts.width() || $('#chartArea')?.clientWidth || 0;
  const paneHeight = chart.paneSize(0)?.height || $('#chartArea')?.clientHeight || 0;

  const buy = side === 'LONG';
  const dir = buy ? 1 : -1;
  const tpPct = Number.isFinite(takeProfitPrice) && entryPrice
    ? ((takeProfitPrice - entryPrice) / entryPrice) * 100 * dir : null;
  const slPct = Number.isFinite(stopPrice) && entryPrice
    ? ((entryPrice - stopPrice) / entryPrice) * 100 * dir : null;
  const rr = tpPct != null && slPct != null && slPct > 0 ? tpPct / slPct : null;

  wrap.style.display = 'block';
  const svg = wrap.querySelector('.pos-projection-lines');
  if (svg) {
    svg.setAttribute('width', String(chartWidth));
    svg.setAttribute('height', String(paneHeight));
  }

  const tpEl = wrap.querySelector('[data-role="tp"]');
  const entryEl = wrap.querySelector('[data-role="entry"]');
  const slEl = wrap.querySelector('[data-role="sl"]');
  const tpLine = svg?.querySelector('.pos-projection-line--tp');
  const entryLine = svg?.querySelector('.pos-projection-line--entry');
  const slLine = svg?.querySelector('.pos-projection-line--sl');

  if (tpEl) {
    tpEl.textContent = Number.isFinite(takeProfitPrice)
      ? `목표 ${formatPrice(takeProfitPrice)}${tpPct != null ? ` (+${tpPct.toFixed(2)}%)` : ''}`
      : '';
    layoutPositionLabelRow(tpEl, tpLine, takeProfitPrice, '#26a69a', chartWidth, paneHeight);
    layoutPositionHitStrip(wrap, 'tp', takeProfitPrice, chartWidth, paneHeight);
  }
  if (slEl) {
    slEl.textContent = Number.isFinite(stopPrice)
      ? `손절 ${formatPrice(stopPrice)}${slPct != null ? ` (-${slPct.toFixed(2)}%)` : ''}`
      : '';
    layoutPositionLabelRow(slEl, slLine, stopPrice, '#ef5350', chartWidth, paneHeight);
    layoutPositionHitStrip(wrap, 'sl', stopPrice, chartWidth, paneHeight);
  }
  if (entryEl) {
    entryEl.classList.toggle('pos-projection-label--short', !buy);
    const displayEntry = showEntry !== false && Number.isFinite(entryPrice);
    entryEl.textContent = displayEntry
      ? `${buy ? '롱' : '숏'} ${formatPrice(entryPrice)}${rr != null ? ` · R:R ${rr.toFixed(2)}` : ''}`
      : '';
    const entryColor = buy ? '#2962ff' : '#f7931a';
    layoutPositionLabelRow(entryEl, entryLine, displayEntry ? entryPrice : null, entryColor, chartWidth, paneHeight);
  }
}

function clearPositionOverlay() {
  positionOverlayPending = null;
  positionAutoscalePrices = [];
  const labelWrap = document.getElementById('chartPositionLabels');
  if (labelWrap) {
    labelWrap.style.display = 'none';
    labelWrap.querySelectorAll('.pos-projection-line').forEach((line) => {
      line.setAttribute('visibility', 'hidden');
    });
  }
  if (chart) {
    for (const s of [positionSlSeries, positionTpSeries, positionEntrySeries]) {
      if (s) { try { chart.removeSeries(s); } catch { /* ignore */ } }
    }
  }
  positionSlSeries = positionTpSeries = positionEntrySeries = null;
  if (candleSeries && positionOverlay) {
    for (const pl of [positionOverlay.entry, positionOverlay.stop, positionOverlay.tp]) {
      if (pl) { try { candleSeries.removePriceLine(pl); } catch { /* ignore */ } }
    }
  }
  positionOverlay = null;
}

function setPositionOverlay(pos) {
  if (!pos) { clearPositionOverlay(); return; }
  const { side, entryPrice, stopPrice, takeProfitPrice, entryTime, showEntry = true } = pos;
  if (side !== 'LONG' && side !== 'SHORT') { clearPositionOverlay(); return; }

  if (positionOverlayPending?.side && positionOverlayPending.side !== side) {
    clearPositionOverlay();
  }

  positionOverlayPending = { side, entryPrice, stopPrice, takeProfitPrice, entryTime, showEntry };
  positionAutoscalePrices = [
    showEntry !== false ? entryPrice : null,
    stopPrice,
    takeProfitPrice,
  ].filter(Number.isFinite);

  if (!chart || !candleSeries) return;
  renderPositionOverlaySegments();
}

function getBarIntervalSeconds(candles) {
  if (!candles || candles.length < 2) return 60;
  return Math.max(1, candles[1].time - candles[0].time);
}

function clearBacktestOverlaySegments() {
  if (chart) {
    for (const s of backtestSlSegments) {
      try { chart.removeSeries(s); } catch { /* ignore */ }
    }
    for (const s of backtestTpSegments) {
      try { chart.removeSeries(s); } catch { /* ignore */ }
    }
  }
  backtestSlSegments = [];
  backtestTpSegments = [];
}

function setBacktestTradeOverlays(_trades, _chartCandles) {
  if (!chart || !candleSeries) return;
  clearBacktestOverlaySegments();
  // Backtest SL/TP dashed lines disabled — entry/exit markers only.
}

function clearBacktestTradeOverlays() {
  clearBacktestOverlaySegments();
}

function focusChartTimeRange(fromTime, toTime, padBars = 10) {
  if (!chart || !state.lastCandles.length || fromTime == null || toTime == null) return false;
  const candles = state.lastCandles;
  const barSec = getBarIntervalSeconds(candles);
  const pad = padBars * barSec;
  const lo = fromTime - pad;
  const hi = toTime + pad;
  let fromIdx = candles.findIndex((c) => c.time >= lo);
  let toIdx = candles.findIndex((c) => c.time >= hi);
  if (fromIdx < 0) fromIdx = 0;
  if (toIdx < 0) toIdx = candles.length - 1;
  if (toIdx <= fromIdx) toIdx = Math.min(fromIdx + 40, candles.length - 1);

  state.programmaticScroll = true;
  chart.timeScale().setVisibleLogicalRange({ from: fromIdx, to: toIdx + 2 });
  state.programmaticScroll = false;
  setFollowingRealtime(false);
  return true;
}

function setChartTypeMode(type) {
  if (!['candlestick', 'line'].includes(type)) return false;
  state.chartType = type;
  $$('[data-chart-type]').forEach((b) => {
    b.classList.toggle('active', b.dataset.chartType === type);
  });
  setChartType(type);
  return true;
}

window.CryptoCharts = {
  getState: () => ({
    coin: state.selectedCoin,
    symbol: state.binanceSymbol,
    interval: state.interval,
    chartType: state.chartType,
    price: state.lastTickPrice || state.lastCandles.at(-1)?.close || null,
    change24h: state.selectedCoin?.price_change_percentage_24h ?? null,
  }),
  getCandles: () => state.lastCandles,
  getCandleCount: () => state.lastCandles.length,
  getPrice: () => state.lastTickPrice || state.lastCandles.at(-1)?.close || null,
  setMarkers: (markers) => {
    if (candleSeries) candleSeries.setMarkers(markers || []);
  },
  setBacktestTradeOverlays,
  clearBacktestTradeOverlays,
  focusChartTimeRange,
  loadHistoryUntilTime,
  setSwingLevels: setSwingLevelLines,
  clearSwingLevels: () => setSwingLevelLines(null),
  setStopLossLine,
  clearStopLossLine: () => setStopLossLine(null),
  setSignalOverlay,
  clearSignalOverlay,
  setPositionOverlay,
  clearPositionOverlay,
  setSlTpDragHandler,
  selectCoin: selectCoinByQuery,
  setInterval: setChartInterval,
  setChartType: setChartTypeMode,
  reloadChart: () => loadChart(),
  getActiveIndicators: () => [...IndicatorManager.active].map((id) => ({
    id,
    name: IndicatorManager.getDisplayName(id),
    params: IndicatorManager.getParams(id),
  })),
  toggleIndicator: (id, on) => {
    if (!IndicatorManager.INDICATOR_REGISTRY.find((d) => d.id === id)) return false;
    IndicatorManager.toggle(id, on);
    const inp = document.querySelector(`input[data-indicator="${id}"]`);
    if (inp) inp.checked = on;
    return true;
  },
  clearIndicators: () => {
    [...IndicatorManager.active].forEach((id) => {
      IndicatorManager.toggle(id, false);
      const inp = document.querySelector(`input[data-indicator="${id}"]`);
      if (inp) inp.checked = false;
    });
  },
  setIndicatorParams: (id, params) => IndicatorManager.setParams(id, params),
  registry: () => IndicatorManager.INDICATOR_REGISTRY,
};

window.CryptoCharts.setBacktestTradeOverlays = setBacktestTradeOverlays;
window.CryptoCharts.clearBacktestTradeOverlays = clearBacktestTradeOverlays;
window.CryptoCharts.focusChartTimeRange = focusChartTimeRange;
window.CryptoCharts.loadHistoryUntilTime = loadHistoryUntilTime;
window.CryptoCharts.setSignalOverlay = setSignalOverlay;
window.CryptoCharts.clearSignalOverlay = clearSignalOverlay;
window.CryptoCharts.setPositionOverlay = setPositionOverlay;
window.CryptoCharts.clearPositionOverlay = clearPositionOverlay;
window.CryptoCharts.setSlTpDragHandler = setSlTpDragHandler;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
