/* TradingView Advanced Chart — display only.
 * Bot / backtest / SL·TP still use CryptoCharts (Lightweight Charts) under the hood. */
(function () {
  const TV_SCRIPT = 'https://s3.tradingview.com/tv.js';
  const STORAGE_KEY = 'orbinex_chart_display';
  const INTERVAL_TO_TV = {
    '1m': '1',
    '5m': '5',
    '15m': '15',
    '1h': '60',
    '4h': '240',
    '1d': 'D',
  };

  let scriptPromise = null;
  let widget = null;
  let mountedKey = '';
  let mode = 'tv'; // 'tv' | 'orbinex'
  let hostEl = null;
  let toggleBtn = null;

  function loadScript() {
    if (window.TradingView?.widget) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${TV_SCRIPT}"]`);
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('TradingView script failed')), { once: true });
        if (window.TradingView?.widget) resolve();
        return;
      }
      const s = document.createElement('script');
      s.src = TV_SCRIPT;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('TradingView script failed'));
      document.head.appendChild(s);
    });
    return scriptPromise;
  }

  function toTvSymbol(binanceSymbol) {
    const raw = String(binanceSymbol || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Binance USDT-M perpetual on TradingView
    return `BINANCE:${raw}.P`;
  }

  function toTvInterval(interval) {
    return INTERVAL_TO_TV[interval] || '60';
  }

  function readSavedMode() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === 'orbinex' || v === 'tv') return v;
    } catch { /* ignore */ }
    return 'tv';
  }

  function saveMode(next) {
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  }

  function applyBodyMode() {
    document.body.classList.toggle('trading-page--tv', mode === 'tv');
    document.body.classList.toggle('trading-page--orbinex', mode === 'orbinex');
    if (toggleBtn) {
      toggleBtn.textContent = mode === 'tv' ? 'Orbinex chart' : 'TradingView';
      toggleBtn.title = mode === 'tv'
        ? 'Switch to Orbinex chart (overlays / backtest markers)'
        : 'Switch to TradingView chart';
      toggleBtn.setAttribute('aria-pressed', mode === 'tv' ? 'true' : 'false');
    }
    try {
      window.TvLevelsOverlay?.setActive?.(mode === 'tv');
    } catch { /* ignore */ }
  }

  function currentState() {
    const st = window.CryptoCharts?.getState?.() || {};
    return {
      symbol: st.symbol || 'BTCUSDT',
      interval: st.interval || '1h',
    };
  }

  function destroyWidget() {
    widget = null;
    mountedKey = '';
    if (hostEl) hostEl.innerHTML = '';
  }

  async function mountWidget(force = false) {
    if (mode !== 'tv' || !hostEl) return;
    const { symbol, interval } = currentState();
    const tvSymbol = toTvSymbol(symbol);
    const tvInterval = toTvInterval(interval);
    const key = `${tvSymbol}|${tvInterval}`;
    if (!force && key === mountedKey && hostEl.querySelector('iframe')) return;

    try {
      await loadScript();
    } catch (err) {
      console.warn('[TvChart]', err);
      hostEl.innerHTML = '<div class="tv-chart-host__fallback">Could not load TradingView. Switch to Orbinex chart.</div>';
      return;
    }

    destroyWidget();
    const containerId = 'tv_chart_widget';
    const box = document.createElement('div');
    box.id = containerId;
    box.className = 'tv-chart-host__frame';
    hostEl.appendChild(box);

    widget = new window.TradingView.widget({
      autosize: true,
      symbol: tvSymbol,
      interval: tvInterval,
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      toolbar_bg: '#181b21',
      enable_publishing: false,
      allow_symbol_change: false,
      hide_top_toolbar: false,
      hide_legend: true,
      details: false,
      hide_side_toolbar: false,
      withdateranges: true,
      save_image: false,
      container_id: containerId,
      studies: [],
    });
    mountedKey = key;
  }

  function setMode(next) {
    if (next !== 'tv' && next !== 'orbinex') return;
    mode = next;
    saveMode(mode);
    applyBodyMode();
    if (mode === 'tv') {
      mountWidget(true);
    } else {
      destroyWidget();
      // Nudge Lightweight Charts to reflow after becoming visible again.
      try {
        window.dispatchEvent(new Event('resize'));
        window.CryptoCharts?.reloadChart?.();
      } catch { /* ignore */ }
    }
  }

  function syncFromChart() {
    if (mode !== 'tv') return;
    mountWidget(false);
  }

  function init() {
    if (!document.body.classList.contains('trading-page')) return;
    hostEl = document.getElementById('tvChartHost');
    toggleBtn = document.getElementById('chartDisplayToggleBtn');
    if (!hostEl) return;

    mode = readSavedMode();
    applyBodyMode();

    toggleBtn?.addEventListener('click', () => {
      setMode(mode === 'tv' ? 'orbinex' : 'tv');
    });

    document.addEventListener('chart-candles-updated', syncFromChart);
    window.addEventListener('orbinex:symbol-changed', syncFromChart);

    if (mode === 'tv') {
      // Chart engine may still be loading — retry a few times.
      mountWidget(true);
      let tries = 0;
      const boot = setInterval(() => {
        tries += 1;
        syncFromChart();
        if (mountedKey || tries > 20) clearInterval(boot);
      }, 500);
    }

    window.TvChartWidget = {
      setMode,
      getMode: () => mode,
      sync: syncFromChart,
      remount: () => mountWidget(true),
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
