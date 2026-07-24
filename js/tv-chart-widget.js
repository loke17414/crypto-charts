/* TradingView Advanced Chart - display only.
 * Bot / backtest / SL-TP still use CryptoCharts (Lightweight Charts) under the hood. */
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
    if (window.TradingView && window.TradingView.widget) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + TV_SCRIPT + '"]');
      if (existing) {
        existing.addEventListener('load', function () { resolve(); }, { once: true });
        existing.addEventListener('error', function () { reject(new Error('TradingView script failed')); }, { once: true });
        if (window.TradingView && window.TradingView.widget) resolve();
        return;
      }
      var s = document.createElement('script');
      s.src = TV_SCRIPT;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('TradingView script failed')); };
      document.head.appendChild(s);
    });
    return scriptPromise;
  }

  function toTvSymbol(binanceSymbol) {
    var raw = String(binanceSymbol || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return 'BINANCE:' + raw + '.P';
  }

  function toTvInterval(interval) {
    return INTERVAL_TO_TV[interval] || '60';
  }

  function readSavedMode() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v === 'orbinex' || v === 'tv') return v;
    } catch (e) { /* ignore */ }
    return 'tv';
  }

  function saveMode(next) {
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* ignore */ }
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
  }

  function currentState() {
    var st = (window.CryptoCharts && window.CryptoCharts.getState && window.CryptoCharts.getState()) || {};
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

  async function mountWidget(force) {
    if (mode !== 'tv' || !hostEl) return;
    var state = currentState();
    var tvSymbol = toTvSymbol(state.symbol);
    var tvInterval = toTvInterval(state.interval);
    var key = tvSymbol + '|' + tvInterval;
    if (!force && key === mountedKey && hostEl.querySelector('iframe')) return;

    try {
      await loadScript();
    } catch (err) {
      console.warn('[TvChart]', err);
      hostEl.innerHTML = '<div class="tv-chart-host__fallback">Could not load TradingView. Switch to Orbinex chart.</div>';
      return;
    }

    destroyWidget();
    var containerId = 'tv_chart_widget';
    var box = document.createElement('div');
    box.id = containerId;
    box.className = 'tv-chart-host__frame';
    hostEl.appendChild(box);

    widget = new window.TradingView.widget({
      autosize: true,
      symbol: tvSymbol,
      interval: tvInterval,
      timezone: 'Asia/Seoul',
      theme: 'dark',
      style: '1',
      locale: 'kr',
      toolbar_bg: '#181b21',
      enable_publishing: false,
      allow_symbol_change: false,
      hide_top_toolbar: false,
      hide_legend: false,
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
      try {
        window.dispatchEvent(new Event('resize'));
        if (window.CryptoCharts && window.CryptoCharts.reloadChart) {
          window.CryptoCharts.reloadChart();
        }
      } catch (e) { /* ignore */ }
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

    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        setMode(mode === 'tv' ? 'orbinex' : 'tv');
      });
    }

    document.addEventListener('chart-candles-updated', syncFromChart);
    window.addEventListener('orbinex:symbol-changed', syncFromChart);

    if (mode === 'tv') {
      mountWidget(true);
      var tries = 0;
      var boot = setInterval(function () {
        tries += 1;
        syncFromChart();
        if (mountedKey || tries > 20) clearInterval(boot);
      }, 500);
    }

    window.TvChartWidget = {
      setMode: setMode,
      getMode: function () { return mode; },
      sync: syncFromChart,
      remount: function () { return mountWidget(true); },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
