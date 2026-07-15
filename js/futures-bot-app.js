/* Futures auto-trading — uses CryptoCharts for chart display */
const FuturesBotApp = (() => {
  const BACKTEST_TRADES_MIN = 1;
  const BACKTEST_TRADES_MAX = 100;
  const BACKTEST_TRADES_DEFAULT = 100;

  const INTERVALS = {
    '1m': { label: '1분' },
    '5m': { label: '5분' },
    '15m': { label: '15분' },
    '1h': { label: '1시간' },
    '4h': { label: '4시간' },
    '1d': { label: '1일' },
  };

  let botTimer = null;
  let botRunning = false;
  let serverBotActive = false;
  let statusPollTimer = null;
  let lastCandles = [];
  let testnetStatus = null;
  let showBacktest = true;
  let backtestDebounce = null;
  let backtestRunId = 0;
  let backtestHistoryCache = null;
  let lastRenderedBacktestKey = null;
  const chartIndicators = { ema: false, rsi: false, macd: false };
  let sessionStartEquity = 0;
  let positionStopPrice = null;
  let positionTakeProfitPrice = null;
  let liveExitBusy = false;
  let autoEntryBusy = false;
  let lastAutoEntryKey = null;
  let autoEntryRetryAt = 0;
  let lastSkipLogKey = null;
  let autoEntryPausedUntil = 0;
  let manualCloseBusy = false;

  const state = {
    mode: 'paper',
    symbol: 'BTCUSDT',
    interval: '1h',
    leverage: 5,
    riskPerTradePct: 1.0,
    maxAccountLossPct: 5.0,
    allowShort: true,
    emaFast: 12,
    emaSlow: 26,
    useMacd: true,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    useMacdLineFilter: false,
    macdLongMin: null,
    macdShortMax: null,
    useRsiEntryFilter: true,
    rsiLongMin: 50,
    rsiShortMax: null,
    useSwingLevels: false,
    showSwingOnChart: true,
    swingPivotBars: 5,
    swingLookback: 50,
    swingNearPct: 0.5,
    swingMode: 'bounce',
    useSwingStopLoss: false,
    swingStopBufferPct: 0,
    rsiPeriod: 14,
    rsiOversold: 25,
    rsiOverbought: 70,
    stopLossPct: 1.5,
    takeProfitPct: 3,
    pollSeconds: 60,
    backtestTradeCount: BACKTEST_TRADES_DEFAULT,
    lastPrice: 0,
    entryRules: null,
    exitRules: null,
  };

  const ENTRY_RULES_KEY = 'crypto-charts-entry-rules';

  function loadStrategyStorage() {
    try {
      const raw = localStorage.getItem(ENTRY_RULES_KEY);
      if (!raw) return { entryRules: null, exitRules: null };
      const parsed = JSON.parse(raw);
      if (parsed && (parsed.long || parsed.short) && !parsed.entryRules) {
        return {
          entryRules: window.StrategyEngine?.sanitizeEntryRules?.(parsed) ?? parsed,
          exitRules: null,
        };
      }
      return {
        entryRules: parsed?.entryRules
          ? (window.StrategyEngine?.sanitizeEntryRules?.(parsed.entryRules) ?? parsed.entryRules)
          : null,
        exitRules: parsed?.exitRules ?? null,
      };
    } catch {
      return { entryRules: null, exitRules: null };
    }
  }

  function saveStrategyStorage(entryRules, exitRules) {
    if (!entryRules && !exitRules) {
      localStorage.removeItem(ENTRY_RULES_KEY);
      return;
    }
    const payload = {
      entryRules: entryRules
        ? (window.StrategyEngine?.sanitizeEntryRules?.(entryRules) ?? entryRules)
        : null,
      exitRules: exitRules || null,
    };
    localStorage.setItem(ENTRY_RULES_KEY, JSON.stringify(payload));
  }

  function loadEntryRules() {
    return loadStrategyStorage().entryRules;
  }

  function saveEntryRules(rules) {
    saveStrategyStorage(rules, state.exitRules);
  }

  const $ = (sel) => document.querySelector(sel);

  function getSettings() {
    return {
      leverage: state.leverage,
      emaFast: state.emaFast,
      emaSlow: state.emaSlow,
      useMacd: state.useMacd,
      macdFast: state.macdFast,
      macdSlow: state.macdSlow,
      macdSignal: state.macdSignal,
      useMacdLineFilter: state.useMacdLineFilter,
      macdLongMin: state.macdLongMin,
      macdShortMax: state.macdShortMax,
      useRsiEntryFilter: state.useRsiEntryFilter,
      rsiLongMin: state.rsiLongMin,
      rsiShortMax: state.rsiShortMax,
      useSwingLevels: state.useSwingLevels,
      swingPivotBars: state.swingPivotBars,
      swingLookback: state.swingLookback,
      swingNearPct: state.swingNearPct,
      swingMode: state.swingMode,
      useSwingStopLoss: state.useSwingStopLoss,
      swingStopBufferPct: state.swingStopBufferPct,
      rsiPeriod: state.rsiPeriod,
      rsiOversold: state.rsiOversold,
      rsiOverbought: state.rsiOverbought,
      allowShort: state.allowShort,
      stopLossPct: state.stopLossPct,
      takeProfitPct: state.takeProfitPct,
      entryRules: state.entryRules,
      exitRules: state.exitRules,
    };
  }

  // Build the full strategy config the headless server bot (bot-js) consumes.
  // It is a superset of getSettings() plus the runtime params (symbol, interval,
  // risk, poll) so the server makes byte-for-byte identical decisions to the UI.
  function buildServerStrategyExport() {
    readFormSettings();
    const s = getSettings();
    return {
      symbol: state.symbol,
      interval: state.interval,
      leverage: state.leverage,
      riskPerTradePct: state.riskPerTradePct,
      maxAccountLossPct: state.maxAccountLossPct,
      pollSeconds: state.pollSeconds,
      allowShort: s.allowShort,
      stopLossPct: s.stopLossPct,
      takeProfitPct: s.takeProfitPct,
      rsiPeriod: s.rsiPeriod,
      rsiOversold: s.rsiOversold,
      rsiOverbought: s.rsiOverbought,
      entryRules: s.entryRules,
      exitRules: s.exitRules,
    };
  }

  function exportStrategyForServer() {
    const payload = buildServerStrategyExport();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'strategy.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    addLog('전략을 strategy.json으로 내보냈습니다. 서버 프로젝트 루트에 넣고 봇을 실행하세요.', 'info');
  }

  function getRiskSettings() {
    return {
      riskPerTradePct: state.riskPerTradePct,
      leverage: state.leverage,
      stopLossPct: state.stopLossPct,
    };
  }

  function getFormStateForAi() {
    readFormSettings();
    return {
      symbol: state.symbol,
      interval: state.interval,
      rsiPeriod: state.rsiPeriod,
      rsiOversold: state.rsiOversold,
      rsiOverbought: state.rsiOverbought,
      stopLossPct: state.stopLossPct,
      takeProfitPct: state.takeProfitPct,
      allowShort: state.allowShort,
      leverage: state.leverage,
      riskPerTradePct: state.riskPerTradePct,
      maxAccountLossPct: state.maxAccountLossPct,
      pollSeconds: state.pollSeconds,
      entryRules: state.entryRules,
      exitRules: state.exitRules,
      indicatorCatalog: window.StrategyEngine?.catalogForAi?.() || '',
    };
  }

  function getMarketContextForAi() {
    readFormSettings();
    syncFromChart();
    const candles = lastCandles.length ? lastCandles : (CryptoCharts?.getCandles?.() || []);
    if (!candles.length) {
      return { symbol: state.symbol, interval: state.interval, candleCount: 0 };
    }

    const closes = candles.map((c) => c.close);
    const price = closes.at(-1) || 0;
    const lookback = Math.min(24, closes.length - 1);
    const base = closes[closes.length - 1 - lookback] || price;
    const changePct = base ? ((price - base) / base) * 100 : 0;

    let rsi14 = null;
    if (window.TA?.rsi) {
      const rsiSeries = TA.rsi(candles, state.rsiPeriod || 14);
      const last = rsiSeries?.at(-1);
      rsi14 = last?.value ?? last ?? null;
    }

    const last20 = candles.slice(-20);
    const upBars = last20.filter((c, i, arr) => i > 0 && c.close > arr[i - 1].close).length;

    return {
      symbol: state.symbol,
      interval: state.interval,
      candleCount: candles.length,
      price: Math.round(price * 100) / 100,
      change24BarsPct: Math.round(changePct * 100) / 100,
      rsi14: rsi14 != null ? Math.round(rsi14 * 10) / 10 : null,
      last20Bars: { up: upBars, down: Math.max(0, last20.length - 1 - upBars) },
      recentHigh: Math.max(...candles.slice(-lookback).map((c) => c.high)),
      recentLow: Math.min(...candles.slice(-lookback).map((c) => c.low)),
    };
  }

  function getBacktestSnapshotForAi() {
    readFormSettings();
    syncFromChart();
    const candles = lastCandles.length ? lastCandles : (CryptoCharts?.getCandles?.() || []);
    const settings = getSettings();
    const targetTrades = state.backtestTradeCount || BACKTEST_TRADES_DEFAULT;

    if (!candles.length || !window.FuturesStrategy?.backtest) {
      return { current: null, targetTrades, candlesUsed: 0 };
    }

    const { stats } = FuturesStrategy.backtest(candles, settings, { maxTrades: targetTrades });
    return {
      current: {
        trades: stats.trades,
        totalTrades: stats.totalTrades,
        wins: stats.wins,
        losses: stats.losses,
        winRate: Math.round((stats.winRate || 0) * 10) / 10,
        totalPnlPct: Math.round((stats.totalPnlPct || 0) * 100) / 100,
        candlesUsed: stats.candlesUsed,
        targetTrades: stats.targetTrades,
        targetReached: stats.targetReached,
      },
      targetTrades,
      candlesUsed: candles.length,
      interval: state.interval,
      symbol: state.symbol,
    };
  }

  function setFieldValue(id, value) {
    const el = document.getElementById(id);
    if (!el || value == null) return;
    if (el.type === 'checkbox') {
      el.checked = Boolean(value);
      return;
    }
    el.value = String(value);
  }

  function updateStrategyRulesDisplay(settings = null, rulesHtml = null) {
    const el = $('#strategyRules');
    if (!el) return;
    if (rulesHtml) {
      el.innerHTML = rulesHtml;
      return;
    }
    readFormSettings();
    const s = settings || getSettings();
    if (window.StrategyEngine) {
      const rules = StrategyEngine.normalizeRules(s);
      const summary = StrategyEngine.rulesSummary(rules);
      const exitHint = formatExitRulesSummary(s.exitRules);
      el.innerHTML = [
        `· <strong>롱/숏 조건</strong>: ${summary}`,
        exitHint,
        `· 손절 -${s.stopLossPct}% · 익절 +${s.takeProfitPct}% (진입가 기준, 동적 SL/TP 우선)`,
        '· 차트에 지표를 켜지 않아도 자동 계산됩니다',
      ].filter(Boolean).join('<br>\n');
      return;
    }
    const shortLine = s.allowShort
      ? `· <strong>숏</strong>: RSI ≥ ${s.rsiOverbought} (과매수)`
      : '· <strong>숏</strong>: 비활성';
    el.innerHTML = [
      `· <strong>롱</strong>: RSI ≤ ${s.rsiOversold} (과매도)`,
      shortLine,
      `· 손절 -${s.stopLossPct}% · 익절 +${s.takeProfitPct}% (진입가 기준)`,
    ].join('<br>\n');
  }

  function formatExitRulesSummary(exitRules) {
    if (!exitRules?.long && !exitRules?.short) return '';
    const parts = [];
    if (exitRules.long) {
      const sl = exitRules.long.stopLoss?.type === 'candle_extreme'
        ? `직전봉 ${exitRules.long.stopLoss.field || 'low'}`
        : '설정 %';
      const rr = exitRules.long.takeProfit?.type === 'risk_reward'
        ? `손익비 ${exitRules.long.takeProfit.ratio || 1.5}:1`
        : '설정 %';
      parts.push(`롱 SL ${sl} · TP ${rr}`);
    }
    if (exitRules.short) parts.push('숏 동적 SL/TP');
    return parts.length ? `· <strong>청산</strong>: ${parts.join(' · ')}` : '';
  }

  function applyStrategySettings(settings, { rulesHtml = null, summary = null, changedFields = [] } = {}) {
    if (!settings) return;

    readFormSettings();
    const prevSettings = getSettings();

    setFieldValue('rsiPeriod', settings.rsiPeriod);
    setFieldValue('rsiOversold', settings.rsiOversold);
    setFieldValue('rsiOverbought', settings.rsiOverbought);
    setFieldValue('stopLoss', settings.stopLossPct);
    setFieldValue('takeProfit', settings.takeProfitPct);
    setFieldValue('leverage', settings.leverage);
    setFieldValue('riskPerTrade', settings.riskPerTradePct);
    setFieldValue('maxAccountLoss', settings.maxAccountLossPct);
    setFieldValue('pollSeconds', settings.pollSeconds);
    setFieldValue('allowShort', settings.allowShort);

    readFormSettings();
    if (settings.allowShort === false) {
      state.allowShort = false;
    } else if (settings.allowShort === true) {
      state.allowShort = true;
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'entryRules')) {
      state.entryRules = settings.entryRules
        ? StrategyEngine.sanitizeEntryRules(settings.entryRules)
        : null;
    }
    if (Object.prototype.hasOwnProperty.call(settings, 'exitRules')) {
      state.exitRules = settings.exitRules
        ? (StrategyEngine.sanitizeExitRules
          ? StrategyEngine.sanitizeExitRules(settings.exitRules)
          : settings.exitRules)
        : null;
    }

    if (state.entryRules && StrategyEngine.validateEntryRules) {
      const { warnings } = StrategyEngine.validateEntryRules(state.entryRules);
      warnings.forEach((w) => addLog(`전략 경고: ${w}`, 'warn'));
    }
    saveStrategyStorage(state.entryRules, state.exitRules);

    readFormSettings();
    const nextSettings = getSettings();
    const strategyChanged = getBacktestCacheKey(nextSettings) !== getBacktestCacheKey(prevSettings);

    backtestHistoryCache = null;

    updateStrategyRulesDisplay(settings, rulesHtml);
    updateChartIndicatorButtons();

    if (strategyChanged) {
      invalidateBacktestChart(lastCandles, { message: '백테스트: 진입 조건 변경 — 재계산 중...' });
      clearTimeout(backtestDebounce);
      applyBacktest(lastCandles, { force: true }).catch((err) => console.error('Backtest failed:', err));
    } else {
      scheduleBacktest(lastCandles);
    }
    updateSignalDisplay();
    updateUI();

    const note = summary || 'AI가 전략 설정을 적용했습니다.';
    const changed = Array.isArray(changedFields) && changedFields.length
      ? ` · 변경: ${changedFields.join(', ')}`
      : '';
    addLog(`${note}${changed}`, 'info');
  }

  function readManualSlTpPrices() {
    const sl = parseFloat($('#stopLossPrice')?.value);
    const tp = parseFloat($('#takeProfitPrice')?.value);
    return {
      stopPrice: Number.isFinite(sl) && sl > 0 ? sl : null,
      takeProfitPrice: Number.isFinite(tp) && tp > 0 ? tp : null,
    };
  }

  function applyManualSlTpOverride(levels, side, entryPrice) {
    if (!levels || !side || !entryPrice) return levels;
    const manual = readManualSlTpPrices();
    const out = { ...levels };
    if (manual.stopPrice != null) {
      out.stopPrice = manual.stopPrice;
      out.stopLossPct = side === 'LONG'
        ? ((entryPrice - manual.stopPrice) / entryPrice) * 100
        : ((manual.stopPrice - entryPrice) / entryPrice) * 100;
    }
    if (manual.takeProfitPrice != null) {
      out.takeProfitPrice = manual.takeProfitPrice;
      out.takeProfitPct = side === 'LONG'
        ? ((manual.takeProfitPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - manual.takeProfitPrice) / entryPrice) * 100;
    }
    return out;
  }

  function calcEntryLevels(side, price = state.lastPrice || lastCandles.at(-1)?.close) {
    readFormSettings();
    if (!price || !side) return null;
    const index = lastCandles.length ? lastCandles.length - 1 : null;
    const levels = FuturesStrategy.calcEntryLevels(side, price, getSettings(), {
      candles: lastCandles,
      index,
    });
    return applyManualSlTpOverride(levels, side, price);
  }

  function calcEntryStopPrice(side) {
    if (side !== 'LONG' && side !== 'SHORT') return null;
    return calcEntryLevels(side)?.stopPrice ?? null;
  }

  function updatePositionOverlay() {
    const setFn = window.CryptoCharts?.setPositionOverlay;
    const clearFn = window.CryptoCharts?.clearPositionOverlay;
    if (!setFn) return;

    let side = null;
    let entryPrice = null;
    let stopPrice = null;
    let takeProfitPrice = null;

    if (isTestnetMode() && testnetStatus?.position) {
      side = testnetStatus.position.side;
      entryPrice = testnetStatus.position.entryPrice;
      stopPrice = positionStopPrice;
      takeProfitPrice = positionTakeProfitPrice;
    } else {
      const pos = FuturesPaper.getPosition();
      if (pos) {
        side = pos.side;
        entryPrice = pos.entryPrice;
        stopPrice = pos.stopPrice ?? positionStopPrice;
        takeProfitPrice = pos.takeProfitPrice ?? positionTakeProfitPrice;
      }
    }

    if (side && entryPrice != null && (stopPrice != null || takeProfitPrice != null)) {
      window.CryptoCharts?.clearSignalOverlay?.();
      setFn({ side, entryPrice, stopPrice, takeProfitPrice });
    } else if (typeof clearFn === 'function') {
      clearFn();
    }
  }

  /** @deprecated use updatePositionOverlay */
  function updatePositionStopLine() {
    updatePositionOverlay();
  }

  function syncOpenPositionSlTp() {
    if (!hasOpenPosition()) return;
    readFormSettings();
    let side;
    let entryPrice;
    if (isTestnetMode()) {
      side = testnetStatus?.position?.side;
      entryPrice = testnetStatus?.position?.entryPrice;
    } else {
      const pos = FuturesPaper.getPosition();
      side = pos?.side;
      entryPrice = pos?.entryPrice;
    }
    if (!side || !entryPrice) return;

    const levels = calcEntryLevels(side, entryPrice);
    if (!levels) return;

    positionStopPrice = levels.stopPrice;
    positionTakeProfitPrice = levels.takeProfitPrice;

    if (!isTestnetMode()) {
      const pos = FuturesPaper.getPosition();
      if (pos) {
        pos.stopPrice = levels.stopPrice;
        pos.takeProfitPrice = levels.takeProfitPrice;
      }
    }
    updatePositionOverlay();
  }

  function clearPositionStop() {
    positionStopPrice = null;
    positionTakeProfitPrice = null;
    window.CryptoCharts?.clearPositionOverlay?.();
    window.CryptoCharts?.clearStopLossLine?.();
  }

  function formatLevelsNote(levels) {
    if (!levels) return '';
    return ` · SL $${levels.stopPrice.toFixed(2)} · TP $${levels.takeProfitPrice.toFixed(2)}`;
  }

  async function getEquity() {
    const price = state.lastPrice;
    if (isTestnetMode()) {
      await refreshTestnetStatus();
      const bal = testnetStatus?.balance ?? 0;
      const pos = testnetStatus?.position;
      if (pos) {
        const margin = (pos.quantity * pos.entryPrice) / (pos.leverage || state.leverage);
        return bal + margin + (pos.unrealizedPnl ?? 0);
      }
      return bal;
    }
    return FuturesPaper.getEquity(price);
  }

  async function calcTradeMarginForTrade() {
    readFormSettings();
    const equity = await getEquity();
    return RiskSizing.calcTradeMargin(equity, getRiskSettings());
  }

  async function checkAccountLossLimit() {
    if (sessionStartEquity <= 0) return false;
    const equity = await getEquity();
    if (RiskSizing.isAccountLossLimitHit(equity, sessionStartEquity, state.maxAccountLossPct)) {
      addLog(
        `계좌 손실 한도 도달 (원금 대비 -${state.maxAccountLossPct}%) — 봇 정지`,
        'loss',
      );
      await stopBot();
      return true;
    }
    return false;
  }

  function updateMacdLineFilterUi() {
    const enabled = $('#useMacdLineFilter')?.checked ?? false;
    ['macdLongMin', 'macdShortMax'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = !enabled;
      el.classList.toggle('input--disabled', !enabled);
    });
  }

  function updateRsiEntryFilterUi() {
    const enabled = $('#useRsiEntryFilter')?.checked ?? false;
    ['rsiLongMin', 'rsiShortMax'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = !enabled;
      el.classList.toggle('input--disabled', !enabled);
    });
  }

  function updateSwingLevelsUi() {
    const show = $('#showSwingOnChart')?.checked ?? true;
    ['swingLookback'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = false;
      el.classList.remove('input--disabled');
    });
    if (!show) {
      updateSwingChartOverlay(lastCandles);
    }
  }

  function hasOpenPosition() {
    if (isTestnetMode()) return Boolean(testnetStatus?.position);
    return Boolean(FuturesPaper.getPosition());
  }

  function isTestnetMode() {
    return state.mode === 'testnet';
  }

  function syncFromChart() {
    if (!window.CryptoCharts) return;
    const cs = CryptoCharts.getState();
    state.interval = cs.interval || state.interval;
    state.lastPrice = CryptoCharts.getPrice() || state.lastPrice;
    lastCandles = CryptoCharts.getCandles() || lastCandles;
  }

  function readFormSettings() {
    state.leverage = parseInt($('#leverage').value, 10) || 5;
    state.riskPerTradePct = parseFloat($('#riskPerTrade').value) || 1;
    state.maxAccountLossPct = parseFloat($('#maxAccountLoss').value) || 5;
    state.allowShort = $('#allowShort') ? $('#allowShort').checked : true;
    state.emaFast = parseInt($('#emaFast')?.value, 10) || 12;
    state.emaSlow = parseInt($('#emaSlow')?.value, 10) || 26;
    const useMacdEl = $('#useMacd');
    state.useMacd = useMacdEl?.type === 'checkbox' ? useMacdEl.checked : true;
    state.macdFast = parseInt($('#macdFast')?.value, 10) || 12;
    state.macdSlow = parseInt($('#macdSlow')?.value, 10) || 26;
    state.macdSignal = parseInt($('#macdSignal')?.value, 10) || 9;
    state.useMacdLineFilter = false;
    state.macdLongMin = null;
    state.macdShortMax = null;
    state.useRsiEntryFilter = true;
    state.rsiLongMin = 50;
    state.rsiShortMax = null;
    state.useSwingLevels = false;
    state.showSwingOnChart = $('#showSwingOnChart')?.checked ?? true;
    state.swingPivotBars = parseInt($('#swingPivotBars')?.value, 10) || 5;
    state.swingLookback = parseInt($('#swingLookback')?.value, 10) || 50;
    state.swingNearPct = 0.5;
    state.swingMode = 'bounce';
    state.useSwingStopLoss = true;
    state.swingStopBufferPct = 0;
    state.rsiOversold = parseFloat($('#rsiOversold')?.value) || 25;
    state.rsiOverbought = parseFloat($('#rsiOverbought')?.value) || 70;
    state.rsiPeriod = parseInt($('#rsiPeriod')?.value, 10) || 14;
    state.stopLossPct = parseFloat($('#stopLoss')?.value) || 1.5;
    state.takeProfitPct = parseFloat($('#takeProfit')?.value) || 3;
    state.pollSeconds = parseInt($('#pollSeconds').value, 10) || 60;
    state.backtestTradeCount = clampBacktestTradeCount($('#backtestTradeCount')?.value);
    syncFromChart();
  }

  function clampBacktestTradeCount(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return BACKTEST_TRADES_DEFAULT;
    return Math.min(BACKTEST_TRADES_MAX, Math.max(BACKTEST_TRADES_MIN, n));
  }

  async function refreshTestnetStatus() {
    if (!isTestnetMode()) return null;
    testnetStatus = await FuturesApiClient.getStatus();
    return testnetStatus;
  }

  function stopStatusPolling() {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  }

  function startStatusPolling() {
    stopStatusPolling();
    if (!isTestnetMode()) return;
    statusPollTimer = setInterval(async () => {
      try {
        await refreshTestnetStatus();
        if (serverBotActive) {
          const st = await FuturesApiClient.getBotStatus();
          if (st && !st.running && botRunning) {
            serverBotActive = false;
            botRunning = false;
            $('#startBotBtn').disabled = false;
            $('#stopBotBtn').disabled = true;
            addLog('서버 봇이 종료되었습니다', 'info');
          }
        }
        updateUI();
      } catch { /* ignore */ }
    }, 3000);
  }

  async function syncStrategyToServer() {
    const strategy = buildServerStrategyExport();
    await FuturesApiClient.syncStrategy(strategy);
    return strategy;
  }

  async function restoreSessionFromServer() {
    const health = await FuturesApiClient.getHealth();
    if (!health?.ok) {
      updateApiServerStatus(false);
      return health;
    }

    updateApiServerStatus(true, health.connected);

    if (health.connected) {
      state.mode = 'testnet';
      FuturesApiClient.setConnected(true);
      await refreshTestnetStatus();
      sessionStartEquity = await getEquity();
      $('#connectApiBtn').disabled = true;
      $('#disconnectApiBtn').disabled = false;
      $('#apiKey').disabled = true;
      $('#apiSecret').disabled = true;
      if (health.credentialsSaved) {
        $('#apiKey').placeholder = '서버에 저장됨';
        $('#apiSecret').placeholder = '서버에 저장됨';
      }
      setModeBadge();
      addLog('서버 API 세션 연결됨 (브라우저를 닫아도 유지)', 'info');
      startStatusPolling();
    } else if (health.credentialsSaved) {
      $('#apiKey').placeholder = '비워두면 저장된 키로 연결';
      $('#apiSecret').placeholder = '비워두면 저장된 키로 연결';
      addLog('API 키가 서버에 저장되어 있습니다. 연결 버튼으로 재연결하세요.', 'info');
    }

    if (health.bot?.running) {
      serverBotActive = true;
      botRunning = true;
      $('#startBotBtn').disabled = true;
      $('#stopBotBtn').disabled = false;
      addLog('서버 봇 실행 중 — 브라우저를 닫아도 24/7 거래 계속', 'info');
    }

    if (health?.ok && health.apiVersion !== 2) {
      addLog('API 서버가 구버전입니다. VPS에서 git pull && sudo systemctl restart crypto-web', 'loss');
    }

    const diag = health?.botDiagnostics;
    if (diag && !diag.nodeFound) {
      addLog('서버에 Node.js가 없습니다. VPS에서 nodejs 설치 후 crypto-web 재시작 필요', 'loss');
    } else if (diag && !diag.botScriptExists) {
      addLog('서버에 bot-js/bot.js가 없습니다. git pull 후 재시작하세요.', 'loss');
    }

    return health;
  }

  function setModeBadge() {
    const badge = $('#modeBadge');
    if (isTestnetMode()) {
      badge.textContent = '테스트넷';
      badge.className = 'paper-badge testnet-badge';
    } else {
      badge.textContent = '모의매매';
      badge.className = 'paper-badge';
    }
  }

  function updateApiServerStatus(online, connected = false) {
    const el = $('#apiServerStatus');
    if (!online) {
      el.textContent = 'API 서버: 오프라인 (run-server.ps1 실행 필요)';
      el.className = 'api-status api-status--offline';
      return;
    }
    el.textContent = connected ? 'API 서버: 연결됨 · 테스트넷 활성' : 'API 서버: 대기 중';
    el.className = connected ? 'api-status api-status--connected' : 'api-status api-status--online';
  }

  function getSwingPivotMarkers(candles) {
    if (!$('#showSwingOnChart')?.checked || !candles?.length) return [];
    readFormSettings();
    const levels = SwingLevels.calcFromCandles(candles, {
      swingPivotBars: state.swingPivotBars,
      swingLookback: state.swingLookback,
    });
    return SwingLevels.buildPivotMarkers(candles, levels);
  }

  function updateSwingChartOverlay(candles) {
    if (!window.CryptoCharts) return;
    const show = $('#showSwingOnChart')?.checked ?? false;
    if (!show || !candles?.length) {
      CryptoCharts.clearSwingLevels();
      return;
    }
    readFormSettings();
    const levels = SwingLevels.calcFromCandles(candles, {
      swingPivotBars: state.swingPivotBars,
      swingLookback: state.swingLookback,
    });
    CryptoCharts.setSwingLevels({
      swingHigh: levels.swingHigh,
      swingLow: levels.swingLow,
    });
  }

  function mergeChartMarkers(tradeMarkers, candles) {
    const swingMarkers = getSwingPivotMarkers(candles);
    if (!swingMarkers.length) return tradeMarkers;
    return [...tradeMarkers, ...swingMarkers].sort((a, b) => a.time - b.time);
  }

  function getActiveStrategyRules() {
    readFormSettings();
    return StrategyEngine?.normalizeRules?.(getSettings()) || null;
  }

  function isStrategyUsingIndicator(names) {
    const rules = getActiveStrategyRules();
    if (!rules || !StrategyEngine?.rulesUseIndicator) return false;
    return StrategyEngine.rulesUseIndicator(rules, names);
  }

  function isStrategyUsingMacd() {
    return isStrategyUsingIndicator(['macd']);
  }

  function isStrategyUsingEma() {
    return isStrategyUsingIndicator(['ema']);
  }

  function isStrategyUsingRsi() {
    return isStrategyUsingIndicator(['rsi']);
  }

  function updateChartIndicatorButtons() {
    document.querySelectorAll('[data-chart-ind]').forEach((btn) => {
      const key = btn.dataset.chartInd;
      const on = chartIndicators[key];
      btn.classList.toggle('ind-toggle--on', on);
      btn.classList.toggle('ind-toggle--off', !on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      const inStrategy = key === 'ema'
        ? isStrategyUsingEma()
        : key === 'rsi'
          ? isStrategyUsingRsi()
          : isStrategyUsingMacd();
      btn.classList.toggle('ind-toggle--unused', !inStrategy);
      if (key === 'ema') {
        btn.title = inStrategy ? '전략 사용 중 — 차트 표시만 토글' : '전략 미사용 — 차트 표시만 토글';
      } else if (key === 'rsi') {
        btn.title = inStrategy ? '전략 사용 중 — 차트 표시만 토글' : '전략 미사용 — 차트 표시만 토글';
      } else {
        btn.title = inStrategy ? '전략 사용 중 — 차트 표시만 토글' : '전략 미사용 — 차트 표시만 토글';
      }
    });
  }

  function syncChartIndicators() {
    if (!window.CryptoCharts) return;
    readFormSettings();

    CryptoCharts.toggleIndicator('rsi', chartIndicators.rsi);
    CryptoCharts.toggleIndicator('macd', chartIndicators.macd);

    if (chartIndicators.ema) {
      CryptoCharts.setIndicatorParams('ema7', { period: state.emaFast, color: '#ffeb3b' });
      CryptoCharts.setIndicatorParams('ema25', { period: state.emaSlow, color: '#00bcd4' });
      CryptoCharts.toggleIndicator('ema7', true);
      CryptoCharts.toggleIndicator('ema25', true);
    } else {
      CryptoCharts.toggleIndicator('ema7', false);
      CryptoCharts.toggleIndicator('ema25', false);
    }

    updateChartIndicatorButtons();
  }

  function hideUnusedChartIndicators() {
    readFormSettings();
    if (!isStrategyUsingMacd()) chartIndicators.macd = false;
    syncChartIndicators();
    addLog('미사용 차트 지표를 껐습니다.', 'info');
  }

  function toggleChartIndicator(key) {
    if (!['ema', 'rsi', 'macd'].includes(key)) return;
    chartIndicators[key] = !chartIndicators[key];
    syncChartIndicators();
  }

  function formatBacktestRange(stats) {
    const bars = stats.candlesUsed ?? 0;
    if (!stats.rangeFromTime || !stats.rangeToTime) return `${bars}봉`;
    const fmt = (t) => new Date(t * 1000).toLocaleString('ko-KR', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const market = window.KlineLoader?.getMarket?.() === 'futures' ? '선물' : '현물';
    return `${bars}봉 · ${market} · ${fmt(stats.rangeFromTime)} ~ ${fmt(stats.rangeToTime)}`;
  }

  function statsFromTrades(trades, base = {}) {
    const wins = trades.filter((t) => t.pnlPct >= 0).length;
    const totalPnl = trades.reduce((s, t) => s + t.pnlPct, 0);
    return {
      ...base,
      trades: trades.length,
      wins,
      losses: trades.length - wins,
      winRate: trades.length ? (wins / trades.length) * 100 : 0,
      totalPnlPct: totalPnl,
    };
  }

  function formatBacktestStats(stats, interval) {
    const pnlCls = stats.totalPnlPct >= 0 ? 'positive' : 'negative';
    const pnlSign = stats.totalPnlPct >= 0 ? '+' : '';
    const intervalLabel = INTERVALS[interval]?.label || interval || '—';
    let countLabel = stats.targetTrades
      ? `${stats.trades}/${stats.targetTrades}회`
      : `${stats.trades}회`;
    if (stats.chartOnly && stats.totalTrades > stats.trades) {
      countLabel = `차트 ${stats.trades}/${stats.totalTrades}회`;
    } else if (stats.targetTrades && !stats.targetReached) {
      countLabel += ` · ${stats.candlesUsed.toLocaleString()}봉 한도`;
    }
    return (
      `백테스트 ${countLabel} (${intervalLabel} ${formatBacktestRange(stats)}) | 승률 ${stats.winRate.toFixed(0)}% ` +
      `(${stats.wins}W ${stats.losses}L) | ` +
      `<span class="${pnlCls}">누적 ${pnlSign}${stats.totalPnlPct.toFixed(2)}%</span>`
    );
  }

  function backtestCacheKey(interval, targetTrades, settings) {
    return `${state.symbol}:${interval}:${targetTrades}:${JSON.stringify(settings)}`;
  }

  function getBacktestCacheKey(settings = getSettings()) {
    const interval = window.CryptoCharts?.getState()?.interval || state.interval;
    readFormSettings();
    return backtestCacheKey(interval, state.backtestTradeCount, settings);
  }

  function clearBacktestChartDisplay(chartCandles) {
    if (!window.CryptoCharts) return;
    const candles = chartCandles?.length ? chartCandles : (CryptoCharts.getCandles() || lastCandles);
    CryptoCharts.setMarkers(getSwingPivotMarkers(candles));
    clearBacktestOverlays();
  }

  function invalidateBacktestChart(chartCandles, { message = null } = {}) {
    backtestRunId += 1;
    backtestHistoryCache = null;
    lastRenderedBacktestKey = null;
    if (showBacktest) clearBacktestChartDisplay(chartCandles);
    const statsEl = $('#backtestStats');
    if (message && statsEl) statsEl.textContent = message;
  }

  function filterTradesToChart(trades, chartCandles) {
    if (!chartCandles?.length || !trades?.length) return [];
    const minTime = chartCandles[0].time;
    const maxTime = chartCandles.at(-1).time;
    return trades.filter((t) => t.exitTime >= minTime && t.entryTime <= maxTime);
  }

  function syncBacktestOverlays(trades, chartCandles) {
    const fn = window.CryptoCharts?.setBacktestTradeOverlays;
    if (typeof fn === 'function') fn(trades, chartCandles);
  }

  function focusBacktestTrades(trades, chartCandles) {
    if (!trades?.length || !chartCandles?.length) return;
    const minTime = chartCandles[0].time;
    const maxTime = chartCandles.at(-1).time;
    const inView = trades.filter((t) => t.exitTime >= minTime && t.entryTime <= maxTime);
    const focusPool = (inView.length ? inView : trades).slice(-8);
    if (!focusPool.length) return;
    const fromT = Math.min(...focusPool.map((t) => t.entryTime));
    const toT = Math.max(...focusPool.map((t) => t.exitTime));
    window.CryptoCharts?.focusChartTimeRange?.(fromT, toT);
  }

  function clearBacktestOverlays() {
    const fn = window.CryptoCharts?.clearBacktestTradeOverlays;
    if (typeof fn === 'function') fn();
  }

  function filterMarkersToChart(markers, chartCandles) {
    if (!chartCandles?.length || !markers?.length) return markers || [];
    const minTime = chartCandles[0].time;
    const maxTime = chartCandles.at(-1).time;
    return markers.filter((m) => m.time >= minTime && m.time <= maxTime);
  }

  async function resolveBacktestCandles(chartCandles, settings, targetTrades, statsEl, runId) {
    const interval = CryptoCharts.getState().interval || state.interval;
    const chartSource = chartCandles?.length ? chartCandles : (CryptoCharts.getCandles() || lastCandles);
    let { stats } = FuturesStrategy.backtest(chartSource, settings, { maxTrades: targetTrades });

    if (stats.trades >= targetTrades || !window.BacktestLoader) {
      return { source: chartSource, fromCache: false };
    }

    const cacheKey = backtestCacheKey(interval, targetTrades, settings);
    if (backtestHistoryCache?.key === cacheKey) {
      const cachedStats = FuturesStrategy.backtest(backtestHistoryCache.candles, settings, { maxTrades: targetTrades }).stats;
      if (cachedStats.trades >= targetTrades || cachedStats.trades > stats.trades) {
        return { source: backtestHistoryCache.candles, fromCache: true };
      }
    }

    if (statsEl) {
      statsEl.textContent = `백테스트: 과거 데이터 로딩 중... (${stats.trades}/${targetTrades}회, ${chartSource.length}봉)`;
    }

    const extended = await BacktestLoader.loadForTargetTrades(
      state.symbol,
      interval,
      settings,
      targetTrades,
      (progress) => {
        if (runId !== backtestRunId || !statsEl) return;
        statsEl.textContent =
          `백테스트: 과거 데이터 로딩 중... (${progress.trades}/${progress.target}회, ` +
          `${progress.candles.toLocaleString()}봉 · ${progress.page}/${progress.maxPages}페이지)`;
      },
      chartSource,
    );

    if (runId !== backtestRunId) return null;

    backtestHistoryCache = { key: cacheKey, candles: extended };
    return { source: extended, fromCache: false };
  }

  async function applyBacktest(chartCandles, { force = false, focusChart = false } = {}) {
    const statsEl = $('#backtestStats');
    if (!window.CryptoCharts) {
      if (statsEl) statsEl.textContent = '백테스트: — (차트 미연동)';
      return;
    }

    updateSwingChartOverlay(chartCandles);
    readFormSettings();
    const settings = getSettings();
    const interval = CryptoCharts.getState().interval || state.interval;
    const source = chartCandles?.length ? chartCandles : (CryptoCharts.getCandles() || lastCandles);
    const minRequired = FuturesStrategy.minBars(settings);

    if (!source.length || source.length < minRequired) {
      CryptoCharts.setMarkers(getSwingPivotMarkers(chartCandles));
      clearBacktestOverlays();
      const reason = !source.length
        ? '차트 데이터 없음 — 잠시 후 다시 시도'
        : `${source.length}봉 (최소 ${minRequired}봉 필요)`;
      if (statsEl) statsEl.textContent = `백테스트: — (${reason})`;
      return;
    }

    try {
      const runId = ++backtestRunId;
      const targetTrades = state.backtestTradeCount;
      const resolved = await resolveBacktestCandles(chartCandles, settings, targetTrades, statsEl, runId);
      if (!resolved || runId !== backtestRunId) return;

      const { source } = resolved;
      const { markers, stats, trades } = FuturesStrategy.backtest(source, settings, { maxTrades: targetTrades });
      let displayCandles = chartCandles?.length ? chartCandles : source;

      if ((showBacktest || force) && focusChart && trades.length && displayCandles.length) {
        const focusPool = trades.slice(-8);
        const earliestEntry = Math.min(...focusPool.map((t) => t.entryTime));
        const chartData = CryptoCharts.getCandles() || displayCandles;
        if (earliestEntry < chartData[0].time) {
          await CryptoCharts.loadHistoryUntilTime?.(earliestEntry);
        }
        displayCandles = CryptoCharts.getCandles() || displayCandles;
      }

      if (runId !== backtestRunId) return;

      let visibleMarkers = filterMarkersToChart(markers, displayCandles);
      let visibleTrades = filterTradesToChart(trades, displayCandles);

      if (runId !== backtestRunId) return;

      if (showBacktest || force) {
        clearBacktestOverlays();
        CryptoCharts.setMarkers(mergeChartMarkers(visibleMarkers, displayCandles));
        syncBacktestOverlays(visibleTrades, displayCandles);
        // Only move the chart when the user explicitly runs backtest — not on
        // every live new-bar refresh (was snapping the view to trade history).
        if (focusChart && trades.length) focusBacktestTrades(trades, displayCandles);
      } else {
        CryptoCharts.setMarkers(getSwingPivotMarkers(displayCandles));
        clearBacktestOverlays();
      }

      let reportStats = stats;
      if ((showBacktest || force) && visibleTrades.length && visibleTrades.length < trades.length) {
        reportStats = statsFromTrades(visibleTrades, {
          ...stats,
          chartOnly: true,
          totalTrades: stats.trades,
          rangeFromTime: visibleTrades[0]?.entryTime ?? stats.rangeFromTime,
          rangeToTime: visibleTrades.at(-1)?.exitTime ?? stats.rangeToTime,
        });
      }

      lastRenderedBacktestKey = backtestCacheKey(interval, targetTrades, settings);
      if (statsEl) statsEl.innerHTML = formatBacktestStats(reportStats, interval);
    } catch (err) {
      console.error('Backtest failed:', err);
      if (statsEl) statsEl.textContent = `백테스트 실패: ${err.message}`;
    }
  }

  function scheduleBacktest(chartCandles) {
    clearTimeout(backtestDebounce);
    readFormSettings();
    const pendingKey = getBacktestCacheKey();
    if (showBacktest && lastRenderedBacktestKey != null && pendingKey !== lastRenderedBacktestKey) {
      invalidateBacktestChart(chartCandles, { message: '백테스트: 조건 변경 — 재계산 중...' });
    }
    backtestDebounce = setTimeout(() => {
      applyBacktest(chartCandles).catch((err) => console.error('Backtest failed:', err));
    }, 600);
  }

  async function runBacktest() {
    const statsEl = $('#backtestStats');
    const btn = $('#runBacktestBtn');
    if (btn) btn.disabled = true;

    try {
      if (!window.CryptoCharts) {
        if (statsEl) statsEl.textContent = '백테스트: — (차트 미연동)';
        return;
      }

      syncFromChart();
      let chartCandles = CryptoCharts.getCandles() || lastCandles;

      if (!chartCandles.length) {
        if (statsEl) statsEl.textContent = '백테스트: 차트 데이터 로딩 중...';
        await CryptoCharts.reloadChart();
        syncFromChart();
        chartCandles = CryptoCharts.getCandles() || lastCandles;
      }

      lastCandles = chartCandles;
      await applyBacktest(chartCandles, { force: true, focusChart: true });
    } catch (err) {
      console.error('Backtest run failed:', err);
      if (statsEl) statsEl.textContent = `백테스트 실패: ${err.message}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function onChartCandlesUpdated(e) {
    lastCandles = e.detail?.candles || CryptoCharts.getCandles() || [];
    state.interval = e.detail?.interval || CryptoCharts.getState().interval;
    state.lastPrice = lastCandles.at(-1)?.close || CryptoCharts.getPrice() || 0;
    scheduleBacktest(lastCandles);
    updateSignalDisplay();
    updateUI();
  }

  function updateRsiDisplay(snapshot) {
    const rsi = StrategyEngine?.snapshotRsi?.(snapshot) ?? snapshot?.rsi;
    if (rsi != null && $('#rsiValue')) {
      $('#rsiValue').textContent = rsi.toFixed(1);
    }
  }

  function updateSignalDisplay() {
    if (!lastCandles.length) return;
    readFormSettings();
    const settings = getSettings();
    const pos = isTestnetMode() ? testnetStatus?.position?.side : FuturesPaper.getPosition()?.side;
    const result = FuturesStrategy.analyze(lastCandles, settings, pos || null);
    $('#signalInfo').textContent = result.reason;
    updateRsiDisplay(result.snapshot);
    syncSignalOverlay(result);
    maybeAutoEnterOnSignal(result);
  }

  // Enter the moment a fresh entry signal appears on the chart instead of
  // waiting for the next botTick poll (default 60s). Works for ANY indicator:
  // level signals (RSI/Stoch/CCI...) persist through the bar and are retried
  // if an attempt fails; edge signals (MACD/EMA cross) are caught in real time.
  // The dedupe key is only consumed on a SUCCESSFUL entry — a failed attempt
  // (API error, margin fetch, stale status) retries after a short backoff.
  function logEntrySkipOnce(key, msg) {
    if (lastSkipLogKey === key) return;
    lastSkipLogKey = key;
    addLog(msg, 'info');
  }

  async function maybeAutoEnterOnSignal(result) {
    if (result.signal !== 'LONG' && result.signal !== 'SHORT') return;
    if (!botRunning) return;

    const barTime = lastCandles.at(-1)?.time;
    const key = `${result.signal}:${barTime}`;

    if (serverBotActive) {
      logEntrySkipOnce(`server:${key}`, `${result.signal} 신호 감지 — 서버 봇이 진입을 처리합니다.`);
      return;
    }
    if (autoEntryBusy || liveExitBusy) return;
    if (Date.now() < autoEntryRetryAt) return;
    if (isAutoEntryPaused()) {
      logEntrySkipOnce(`pause:${key}`, `${result.signal} 신호 — 수동 청산 직후 대기 중이라 진입을 보류합니다.`);
      return;
    }
    if (hasOpenPosition()) return;
    if (result.signal === 'SHORT' && !state.allowShort) {
      logEntrySkipOnce(`short:${key}`, 'SHORT(매도) 신호 — 숏 허용이 꺼져 있어 진입하지 않습니다. (설정에서 숏 허용을 켜세요)');
      return;
    }
    if (key === lastAutoEntryKey) return;

    autoEntryBusy = true;
    try {
      addLog(`${result.signal} 신호 감지 — 즉시 진입 시도 (${result.reason})`, 'info');
      await executeSignal(result);
      if (hasOpenPosition()) {
        lastAutoEntryKey = key;
      } else {
        // Entry did not go through (logged inside executeSignal) — retry while
        // the signal is still valid instead of blacklisting this bar.
        autoEntryRetryAt = Date.now() + 15_000;
      }
      updateUI();
    } catch (err) {
      autoEntryRetryAt = Date.now() + 15_000;
      addLog(`자동 진입 실패: ${err.message} — 15초 후 재시도`, 'loss');
    } finally {
      autoEntryBusy = false;
    }
  }

  // Draw dashed entry/SL/TP lines on the chart whenever the strategy produces a
  // fresh entry (buy/sell) signal, and clear them otherwise. Uses the same
  // dashed convention as the backtest overlays (red = 손절, green = 익절).
  function syncSignalOverlay(result) {
    const setFn = window.CryptoCharts?.setSignalOverlay;
    const clearFn = window.CryptoCharts?.clearSignalOverlay;
    const isEntry = (result.signal === 'LONG' || result.signal === 'SHORT') && result.entryLevels;

    if (isEntry && typeof setFn === 'function') {
      setFn({
        side: result.signal,
        entryPrice: lastCandles.at(-1)?.close,
        stopPrice: result.entryLevels.stopPrice,
        takeProfitPrice: result.entryLevels.takeProfitPrice,
      });
    } else if (typeof clearFn === 'function') {
      clearFn();
    }
  }

  async function connectApi() {
    const apiKey = $('#apiKey').value.trim();
    const apiSecret = $('#apiSecret').value.trim();

    const serverOk = await FuturesApiClient.checkServer();
    if (!serverOk) {
      addLog('API 서버가 실행 중이 아닙니다. run-server.ps1을 실행하세요.', 'loss');
      updateApiServerStatus(false);
      return;
    }

    try {
      readFormSettings();
      let data;
      if (!apiKey || !apiSecret) {
        const health = await FuturesApiClient.getHealth();
        if (!health?.credentialsSaved) {
          addLog('API Key와 Secret을 입력하세요.', 'loss');
          return;
        }
        data = await FuturesApiClient.reconnect();
        addLog('저장된 API 키로 재연결', 'info');
      } else {
        data = await FuturesApiClient.connect(apiKey, apiSecret);
      }
      state.mode = 'testnet';
      const marginPreview = await calcTradeMarginForTrade();
      await FuturesApiClient.setup({
        leverage: state.leverage,
        marginType: 'ISOLATED',
        symbol: state.symbol,
        tradeMarginUsdt: marginPreview,
      });
      await refreshTestnetStatus();
      sessionStartEquity = await getEquity();
      $('#connectApiBtn').disabled = true;
      $('#disconnectApiBtn').disabled = false;
      $('#apiKey').disabled = true;
      $('#apiSecret').disabled = true;
      $('#apiKey').placeholder = '서버에 저장됨';
      $('#apiSecret').placeholder = '서버에 저장됨';
      setModeBadge();
      updateApiServerStatus(true, true);
      startStatusPolling();
      addLog(`테스트넷 연결 성공 — 잔고 $${data.balance.toFixed(2)} USDT (키 서버 저장됨)`, 'info');
      updateUI();
    } catch (err) {
      addLog(`연결 실패: ${err.message}`, 'loss');
    }
  }

  async function disconnectApi() {
    if (!confirm('세션을 해제할까요? 저장된 API 키는 유지되며 서버 봇은 정지됩니다.')) return;
    try {
      if (botRunning) await stopBot();
      await FuturesApiClient.disconnect(false);
    } catch { /* ignore */ }
    stopStatusPolling();
    state.mode = 'paper';
    testnetStatus = null;
    serverBotActive = false;
    FuturesApiClient.setConnected(false);
    $('#connectApiBtn').disabled = false;
    $('#disconnectApiBtn').disabled = true;
    $('#apiKey').disabled = false;
    $('#apiSecret').disabled = false;
    $('#apiKey').placeholder = 'Testnet API Key';
    $('#apiSecret').placeholder = 'Testnet API Secret';
    setModeBadge();
    updateApiServerStatus(await FuturesApiClient.checkServer(), false);
    addLog('세션 해제 — 저장된 키는 서버에 유지 (재연결 가능)', 'info');
    updateUI();
  }

  function addLog(text, type = 'info') {
    const log = $('#tradeLog');
    const item = document.createElement('div');
    item.className = `trade-log__item trade-log__item--${type}`;
    const time = new Date().toLocaleTimeString('ko-KR');
    item.textContent = `[${time}] ${text}`;
    log.prepend(item);
    while (log.children.length > 50) log.lastChild.remove();
  }

  async function updateUI() {
    syncFromChart();
    const price = state.lastPrice;
    $('#btcPrice').textContent = price
      ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '—';

    const posEl = $('#positionInfo');
    readFormSettings();
    const equity = await getEquity();
    const marginPreview = RiskSizing.calcTradeMargin(equity, getRiskSettings());
    const lossAtSl = RiskSizing.estimateLossAtSl(marginPreview, state.leverage, state.stopLossPct);
    const lossPctOfEquity = equity > 0 ? (lossAtSl / equity) * 100 : 0;

    $('#notionalInfo').innerHTML =
      `증거금 $${marginPreview.toFixed(0)} (${state.leverage}x) · ` +
      `<span class="text-muted">손절 시 -$${lossAtSl.toFixed(2)} (${lossPctOfEquity.toFixed(2)}%)</span>`;

    if (sessionStartEquity > 0) {
      const dd = ((sessionStartEquity - equity) / sessionStartEquity) * 100;
      $('#equityInfo').textContent =
        `$${equity.toFixed(2)} (${dd >= 0 ? '-' : '+'}${Math.abs(dd).toFixed(2)}%)`;
      $('#equityInfo').className = dd >= state.maxAccountLossPct * 0.8 ? 'negative' : '';
    } else {
      $('#equityInfo').textContent = `$${equity.toFixed(2)}`;
    }

    $('#botStatus').textContent = botRunning
      ? (serverBotActive ? '서버 실행 중' : '실행 중')
      : '정지';
    $('#botStatus').className = botRunning ? 'bot-status bot-status--on' : 'bot-status bot-status--off';

    if (isTestnetMode()) {
      try {
        await refreshTestnetStatus();
      } catch { /* ignore */ }

      const balance = testnetStatus?.balance ?? 0;
      $('#availableMargin').textContent = `$${balance.toFixed(2)}`;
      $('#totalPnl').textContent = '—';
      $('#totalPnl').className = '';

      const pos = testnetStatus?.position;
      if (!pos) {
        posEl.innerHTML = '<span class="text-muted">포지션 없음</span>';
        $('#positionPnl').textContent = '';
        if (positionStopPrice != null) clearPositionStop();
      } else {
        if (positionStopPrice == null) {
          const levels = calcEntryLevels(pos.side, pos.entryPrice);
          if (levels) {
            positionStopPrice = levels.stopPrice;
            positionTakeProfitPrice = levels.takeProfitPrice;
          }
        }
        const pnl = pos.unrealizedPnl ?? 0;
        const cls = pnl >= 0 ? 'positive' : 'negative';
        const margin = (pos.quantity * pos.entryPrice) / (pos.leverage || state.leverage);
        posEl.innerHTML = `<strong>${pos.side}</strong> ${pos.quantity.toFixed(6)} BTC @ $${pos.entryPrice.toFixed(2)}<br>${pos.leverage || state.leverage}x · 증거금 ~$${margin.toFixed(2)}${positionStopPrice != null ? `<br><span class="text-muted">손절 $${positionStopPrice.toFixed(2)}</span>` : ''}${positionTakeProfitPrice != null ? `<br><span class="text-muted">익절 $${positionTakeProfitPrice.toFixed(2)}</span>` : ''}`;
        $('#positionPnl').innerHTML = `<span class="${cls}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</span>`;
      }
      updatePositionStopLine();
      return;
    }

    const pos = FuturesPaper.getPosition();
    if (!pos) {
      posEl.innerHTML = '<span class="text-muted">포지션 없음</span>';
      $('#positionPnl').textContent = '';
      clearPositionStop();
    } else {
      if (positionStopPrice == null || pos.takeProfitPrice == null) {
        const levels = calcEntryLevels(pos.side, pos.entryPrice);
        if (levels) {
          positionStopPrice = levels.stopPrice;
          positionTakeProfitPrice = levels.takeProfitPrice;
          pos.stopPrice = levels.stopPrice;
          pos.takeProfitPrice = levels.takeProfitPrice;
        }
      } else {
        positionStopPrice = pos.stopPrice;
        positionTakeProfitPrice = pos.takeProfitPrice;
      }
      const pnl = FuturesPaper.unrealizedPnl(price);
      const roe = FuturesPaper.roe(price, pos.leverage);
      const cls = pnl >= 0 ? 'positive' : 'negative';
      posEl.innerHTML = `<strong>${pos.side}</strong> ${pos.quantity.toFixed(6)} BTC @ $${pos.entryPrice.toFixed(2)}<br>${pos.leverage}x · 증거금 $${pos.margin.toFixed(2)}${pos.stopPrice != null ? `<br><span class="text-muted">손절 $${pos.stopPrice.toFixed(2)}</span>` : ''}${pos.takeProfitPrice != null ? `<br><span class="text-muted">익절 $${pos.takeProfitPrice.toFixed(2)}</span>` : ''}`;
      $('#positionPnl').innerHTML = `<span class="${cls}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${roe >= 0 ? '+' : ''}${roe.toFixed(2)}%)</span>`;
    }

    const wallet = FuturesPaper.getWallet();
    $('#availableMargin').textContent = `$${wallet.margin.toFixed(2)}`;
    $('#totalPnl').textContent = `${wallet.totalPnl >= 0 ? '+' : ''}$${wallet.totalPnl.toFixed(2)}`;
    $('#totalPnl').className = wallet.totalPnl >= 0 ? 'positive' : 'negative';
    updatePositionStopLine();
  }

  async function executeSignal(result) {
    const price = state.lastPrice;
    if (await checkAccountLossLimit()) return;

    const tradeMargin = await calcTradeMarginForTrade();

    if (isTestnetMode()) {
      const pos = testnetStatus?.position;

      if (result.signal === 'CLOSE' && pos) {
        try {
          await FuturesApiClient.closePosition();
          clearPositionStop();
          addLog(`${pos.side} 청산 @ $${price.toFixed(2)} — ${result.reason}`, 'info');
          await refreshTestnetStatus();
          updateUI();
        } catch (err) {
          addLog(`청산 실패: ${err.message}`, 'loss');
        }
        return;
      }

      if (result.signal === 'LONG' || result.signal === 'SHORT') {
        if (hasOpenPosition()) return;
        await refreshTestnetStatus();
        if (testnetStatus?.position) {
          addLog(`${result.signal} 신호 — 이미 ${testnetStatus.position.side} 포지션 보유 중이라 진입 생략`, 'info');
          return;
        }
        try {
          readFormSettings();
          const side = result.signal;
          const levels = result.entryLevels || calcEntryLevels(side);
          if (!levels) {
            addLog('진입 실패: 손절/익절 계산 불가', 'loss');
            return;
          }
          await FuturesApiClient.setup({
            leverage: state.leverage,
            marginType: 'ISOLATED',
            symbol: state.symbol,
            tradeMarginUsdt: tradeMargin,
          });
          const r = await FuturesApiClient.openPosition(side, tradeMargin, state.leverage, price);
          positionStopPrice = levels.stopPrice;
          positionTakeProfitPrice = levels.takeProfitPrice;
          addLog(`${side} 진입 ${r.quantity?.toFixed(6) || ''} BTC @ $${price.toFixed(2)}${formatLevelsNote(levels)}`, side === 'LONG' ? 'win' : 'loss');
          updatePositionStopLine();
          await refreshTestnetStatus();
          updateUI();
        } catch (err) {
          addLog(`${result.signal} 진입 실패: ${err.message}`, 'loss');
        }
      }
      return;
    }

    const pos = FuturesPaper.getPosition();

    if (result.signal === 'CLOSE' && pos) {
      const r = FuturesPaper.closePosition(price, result.reason);
      if (r.ok) {
        clearPositionStop();
        addLog(r.message, r.pnl >= 0 ? 'win' : 'loss');
      }
      return;
    }

    if ((result.signal === 'LONG' || result.signal === 'SHORT') && !pos) {
      const side = result.signal;
      const levels = result.entryLevels || calcEntryLevels(side);
      if (!levels) {
        addLog('진입 실패: 손절/익절 계산 불가', 'loss');
        return;
      }
      const r = FuturesPaper.openPosition(
        side,
        price,
        tradeMargin,
        state.leverage,
        levels.stopPrice,
        levels.takeProfitPrice,
      );
      if (r.ok) updatePositionStopLine();
      addLog(r.message + (r.ok ? formatLevelsNote(levels) : ''), r.ok ? (side === 'LONG' ? 'win' : 'loss') : 'loss');
    }
  }

  // Live SL/TP check that runs on every price tick (not just the poll
  // interval). The bot otherwise only polls every `pollSeconds` (default 60s),
  // so a fast wick that touches the stop/take-profit between polls would be
  // missed. Ticks stream through the wick prices, so checking here catches them.
  async function evaluateLiveExit() {
    if (liveExitBusy || !botRunning) return;
    if (isTestnetMode() && serverBotActive) return;
    const price = state.lastPrice;
    if (!price) return;

    readFormSettings();
    const settings = getSettings();

    let posSide = null;
    let entryPrice = null;
    let extras = null;

    if (isTestnetMode()) {
      const pos = testnetStatus?.position;
      if (!pos) return;
      posSide = pos.side;
      entryPrice = pos.entryPrice;
      extras = {
        stopPrice: positionStopPrice,
        takeProfitPrice: positionTakeProfitPrice,
        stopLossPct: settings.stopLossPct,
        takeProfitPct: settings.takeProfitPct,
      };
    } else {
      const pos = FuturesPaper.getPosition();
      if (!pos) return;
      posSide = pos.side;
      entryPrice = pos.entryPrice;
      extras = {
        stopPrice: pos.stopPrice,
        takeProfitPrice: pos.takeProfitPrice,
        stopLossPct: pos.stopLossPct ?? settings.stopLossPct,
        takeProfitPct: pos.takeProfitPct ?? settings.takeProfitPct,
      };
    }

    const exit = FuturesStrategy.checkExit(posSide, entryPrice, price, settings, extras);
    if (!exit) return;

    liveExitBusy = true;
    try {
      await executeSignal(exit);
      $('#signalInfo').textContent = exit.reason;
    } catch (err) {
      addLog(`청산 오류: ${err.message}`, 'loss');
    } finally {
      liveExitBusy = false;
    }
  }

  async function botTick() {
    try {
      readFormSettings();
      if (await checkAccountLossLimit()) return;
      syncFromChart();
      const candles = lastCandles;
      if (!candles.length) return;

      const settings = getSettings();
      const price = state.lastPrice;
      let posSide = null;
      let entryPrice = null;
      let currentPos = null;

      let stopPrice = null;
      let takeProfitPrice = null;

      if (isTestnetMode()) {
        await refreshTestnetStatus();
        currentPos = testnetStatus?.position || null;
        posSide = currentPos?.side || null;
        entryPrice = currentPos?.entryPrice || null;
        stopPrice = currentPos ? positionStopPrice : null;
        takeProfitPrice = currentPos ? positionTakeProfitPrice : null;
      } else {
        currentPos = FuturesPaper.getPosition();
        posSide = currentPos?.side || null;
        entryPrice = currentPos?.entryPrice || null;
        stopPrice = currentPos?.stopPrice ?? null;
        takeProfitPrice = currentPos?.takeProfitPrice ?? null;
      }

      if (posSide && entryPrice && !liveExitBusy) {
        const exit = FuturesStrategy.checkExit(posSide, entryPrice, price, settings, {
          stopPrice,
          takeProfitPrice,
          stopLossPct: currentPos?.stopLossPct ?? settings.stopLossPct,
          takeProfitPct: currentPos?.takeProfitPct ?? settings.takeProfitPct,
        });
        if (exit) {
          liveExitBusy = true;
          try {
            await executeSignal(exit);
            $('#signalInfo').textContent = exit.reason;
          } finally {
            liveExitBusy = false;
          }
          return;
        }
      }

      const result = FuturesStrategy.analyze(candles, settings, posSide);
      $('#signalInfo').textContent = result.reason;
      updateRsiDisplay(result.snapshot);

      if ((result.signal === 'LONG' || result.signal === 'SHORT') && !posSide) {
        if (isAutoEntryPaused()) {
          logEntrySkipOnce(
            `pause:${result.signal}:${candles.at(-1)?.time}`,
            `${result.signal} 신호 — 수동 청산 직후 대기 중이라 진입을 보류합니다.`,
          );
        } else {
          await executeSignal(result);
        }
      }
    } catch (err) {
      addLog(`오류: ${err.message}`, 'loss');
    }
  }

  const BOT_INTERVAL_KEY = 'crypto-charts-bot-interval';

  function getBotIntervalSelection() {
    const active = document.querySelector('#botIntervalPicker [data-bot-interval].active');
    const val = active?.dataset.botInterval
      || localStorage.getItem(BOT_INTERVAL_KEY)
      || 'chart';
    return val;
  }

  function setBotIntervalSelection(val, { persist = true } = {}) {
    const picker = $('#botIntervalPicker');
    if (!picker) return;
    picker.querySelectorAll('[data-bot-interval]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.botInterval === val);
    });
    if (persist) localStorage.setItem(BOT_INTERVAL_KEY, val);
  }

  function botIntervalLabel(val) {
    if (val === 'chart') return '차트와 동일';
    return INTERVALS[val]?.label || val;
  }

  // Resolve which timeframe the bot should trade on when it starts. "chart"
  // keeps whatever the chart shows; an explicit interval switches the chart
  // (the whole pipeline — candles, signals, backtest — follows the chart).
  async function applyBotIntervalOnStart() {
    const sel = getBotIntervalSelection();
    if (sel === 'chart' || !INTERVALS[sel]) return state.interval;

    const chartInterval = window.CryptoCharts?.getState?.()?.interval;
    if (chartInterval !== sel) {
      addLog(`봇 봉 주기 ${INTERVALS[sel].label} — 차트를 전환하는 중...`, 'info');
      const ok = await window.CryptoCharts?.setInterval?.(sel);
      if (!ok) {
        addLog(
          `${INTERVALS[sel].label} 차트 전환 실패 — 현재 ${INTERVALS[state.interval]?.label || state.interval} 기준으로 시작합니다.`,
          'loss',
        );
        return state.interval;
      }
      syncFromChart();
    }
    state.interval = sel;
    return sel;
  }

  async function startBot() {
    if (botRunning) return;
    readFormSettings();
    await applyBotIntervalOnStart();
    sessionStartEquity = await getEquity();

    if (isTestnetMode()) {
      try {
        await syncStrategyToServer();
        const marginPreview = await calcTradeMarginForTrade();
        await FuturesApiClient.setup({
          leverage: state.leverage,
          marginType: 'ISOLATED',
          symbol: state.symbol,
          tradeMarginUsdt: marginPreview,
        });
        await FuturesApiClient.startServerBot();
        serverBotActive = true;
        botRunning = true;
        $('#startBotBtn').disabled = true;
        $('#stopBotBtn').disabled = false;
        startStatusPolling();
        addLog(
          `서버 봇 시작 — BTC ${INTERVALS[state.interval]?.label || state.interval}, ${state.leverage}x (브라우저 닫아도 계속 실행)`,
          'info',
        );
      } catch (err) {
        const hint = /Node\.js|node/i.test(err.message)
          ? ' → VPS SSH: sudo apt install -y nodejs && sudo systemctl restart crypto-web'
          : '';
        addLog(`서버 봇 시작 실패: ${err.message}${hint}`, 'loss');
        return;
      }
    } else {
      botRunning = true;
      $('#startBotBtn').disabled = true;
      $('#stopBotBtn').disabled = false;
      addLog(
        `봇 시작 — BTC ${INTERVALS[state.interval]?.label || state.interval}, ${state.leverage}x, 1회 리스크 ${state.riskPerTradePct}%`,
        'info',
      );
      botTick();
      botTimer = setInterval(botTick, state.pollSeconds * 1000);
    }
    updateUI();
  }

  async function stopBot() {
    if (!botRunning) return;

    if (isTestnetMode() && serverBotActive) {
      try {
        await FuturesApiClient.stopServerBot();
      } catch (err) {
        addLog(`서버 봇 정지 실패: ${err.message}`, 'loss');
      }
      serverBotActive = false;
    } else {
      clearInterval(botTimer);
      botTimer = null;
    }

    botRunning = false;
    $('#startBotBtn').disabled = false;
    $('#stopBotBtn').disabled = true;
    addLog('봇 정지', 'info');
    updateUI();
  }

  async function manualOpen(side) {
    if (!isTestnetMode()) {
      addLog('수동 주문은 테스트넷 연결 후 사용할 수 있습니다.', 'info');
      return;
    }
    if (await checkAccountLossLimit()) return;

    await refreshTestnetStatus();
    if (hasOpenPosition()) {
      addLog('이미 포지션이 있습니다.', 'info');
      return;
    }

    const price = state.lastPrice;
    if (!price) {
      addLog('가격 정보가 없습니다.', 'loss');
      return;
    }

    readFormSettings();
    const tradeMargin = await calcTradeMarginForTrade();
    const levels = calcEntryLevels(side);
    if (!levels) {
      addLog('진입 실패: 손절/익절 계산 불가', 'loss');
      return;
    }

    try {
      await FuturesApiClient.setup({
        leverage: state.leverage,
        marginType: 'ISOLATED',
        symbol: state.symbol,
        tradeMarginUsdt: tradeMargin,
      });
      const r = await FuturesApiClient.openPosition(side, tradeMargin, state.leverage, price);
      positionStopPrice = levels.stopPrice;
      positionTakeProfitPrice = levels.takeProfitPrice;
      addLog(`${side} 수동 진입 ${r.quantity?.toFixed(6) || ''} BTC @ $${price.toFixed(2)}${formatLevelsNote(levels)}`, side === 'LONG' ? 'win' : 'loss');
      updatePositionStopLine();
      await refreshTestnetStatus();
      updateUI();
    } catch (err) {
      addLog(`${side} 진입 실패: ${err.message}`, 'loss');
    }
  }

  // Manual close must not be instantly reversed by the running bot: pause
  // auto entries until the current bar closes (min 30s) after a manual close.
  function pauseAutoEntryAfterManualClose() {
    const secondsMap = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
    const intervalSec = secondsMap[state.interval] || 60;
    const nowSec = Math.floor(Date.now() / 1000);
    const barEndSec = lastCandles.at(-1) ? lastCandles.at(-1).time + intervalSec : nowSec + 60;
    // Pause until the current bar closes, clamped to 30s..15min so long
    // timeframes don't block the bot for hours.
    const pausedUntil = Math.min(barEndSec * 1000, Date.now() + 15 * 60_000);
    autoEntryPausedUntil = Math.max(Date.now() + 30_000, pausedUntil);
    addLog('수동 청산 — 같은 신호로 바로 재진입하지 않도록 자동 진입을 잠시 멈춥니다.', 'info');
  }

  function isAutoEntryPaused() {
    return Date.now() < autoEntryPausedUntil;
  }

  async function manualClose() {
    if (manualCloseBusy) return;
    manualCloseBusy = true;
    const btn = $('#closeBtn');
    if (btn) btn.disabled = true;

    try {
      const price = state.lastPrice;

      if (isTestnetMode()) {
        try {
          await refreshTestnetStatus();
        } catch (err) {
          addLog(`상태 조회 실패, 청산을 바로 시도합니다: ${err.message}`, 'info');
        }
        if (testnetStatus && !testnetStatus.position) {
          addLog('청산할 포지션이 없습니다.', 'info');
          return;
        }
        try {
          const side = testnetStatus?.position?.side || '';
          await FuturesApiClient.closePosition();
          clearPositionStop();
          if (botRunning) pauseAutoEntryAfterManualClose();
          addLog(`${side} 수동 청산 @ $${price.toFixed(2)}`, 'info');
          await refreshTestnetStatus();
          updateUI();
        } catch (err) {
          addLog(`청산 실패: ${err.message}`, 'loss');
        }
        return;
      }

      if (!FuturesPaper.getPosition()) {
        addLog('청산할 포지션이 없습니다.', 'info');
        return;
      }
      const r = FuturesPaper.closePosition(price, '수동 청산');
      if (r.ok) {
        clearPositionStop();
        if (botRunning) pauseAutoEntryAfterManualClose();
      }
      addLog(r.message, r.ok ? (r.pnl >= 0 ? 'win' : 'loss') : 'info');
      updateUI();
    } finally {
      manualCloseBusy = false;
      if (btn) btn.disabled = false;
    }
  }

  function resetWallet() {
    if (isTestnetMode()) {
      addLog('테스트넷 모드에서는 모의 계좌 초기화를 사용할 수 없습니다.', 'info');
      return;
    }
    if (!confirm('모의 계좌를 초기화할까요? (포지션·거래내역 삭제)')) return;
    FuturesPaper.reset();
    sessionStartEquity = FuturesPaper.getEquity(state.lastPrice);
    addLog('모의 계좌 초기화 ($10,000)', 'info');
    updateUI();
  }

  function onChartCandleTick(e) {
    lastCandles = e.detail?.candles || CryptoCharts.getCandles() || [];
    state.interval = e.detail?.interval || CryptoCharts.getState().interval;
    state.lastPrice = lastCandles.at(-1)?.close || CryptoCharts.getPrice() || 0;
    updateSignalDisplay();
    if (botRunning && !(isTestnetMode() && serverBotActive)) evaluateLiveExit();
    if (e.detail?.newBar) {
      scheduleBacktest(lastCandles);
      updateUI();
    }
  }

  function bindUiEvents() {
    document.addEventListener('chart-candles-updated', onChartCandlesUpdated);
    document.addEventListener('chart-candle-tick', onChartCandleTick);

    const picker = $('#botIntervalPicker');
    if (picker) {
      const saved = localStorage.getItem(BOT_INTERVAL_KEY);
      if (saved && (saved === 'chart' || INTERVALS[saved])) {
        setBotIntervalSelection(saved, { persist: false });
      }
      picker.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-bot-interval]');
        if (!btn) return;
        setBotIntervalSelection(btn.dataset.botInterval);
        if (botRunning) {
          addLog(
            `봉 주기 ${botIntervalLabel(btn.dataset.botInterval)} — 다음 봇 시작부터 적용됩니다.`,
            'info',
          );
        }
      });
    }

    $('#showBacktest')?.addEventListener('change', (e) => {
      showBacktest = e.target.checked;
      applyBacktest(lastCandles, { force: true });
    });

    $('#runBacktestBtn')?.addEventListener('click', () => { runBacktest(); });

    const backtestCountEl = $('#backtestTradeCount');
    if (backtestCountEl) {
      const onBacktestCountChange = () => {
        readFormSettings();
        backtestCountEl.value = String(state.backtestTradeCount);
        scheduleBacktest(lastCandles);
      };
      backtestCountEl.addEventListener('change', onBacktestCountChange);
      backtestCountEl.addEventListener('input', onBacktestCountChange);
    }
  }

  async function init() {
    bindUiEvents();

    readFormSettings();
    const stored = loadStrategyStorage();
    state.entryRules = stored.entryRules;
    state.exitRules = stored.exitRules;
    if (state.entryRules || state.exitRules) saveStrategyStorage(state.entryRules, state.exitRules);
    updateStrategyRulesDisplay();
    updateChartIndicatorButtons();
    updateMacdLineFilterUi();
    updateRsiEntryFilterUi();
    updateSwingLevelsUi();
    sessionStartEquity = await getEquity();

    await restoreSessionFromServer();
    setModeBadge();

    if (CryptoCharts.getCandles().length) {
      onChartCandlesUpdated({ detail: { candles: CryptoCharts.getCandles() } });
    }

    addLog('CryptoCharts 차트 연동됨', 'info');
    if (window.CryptoCharts) {
      syncChartIndicators();
    }
    if (await FuturesApiClient.checkServer()) addLog('API 서버 감지 — 테스트넷 키 연결 가능', 'info');

    document.querySelectorAll('[data-chart-ind]').forEach((btn) => {
      btn.addEventListener('click', () => toggleChartIndicator(btn.dataset.chartInd));
    });
    $('#hideUnusedIndicatorsBtn')?.addEventListener('click', hideUnusedChartIndicators);
    $('#exportStrategyBtn')?.addEventListener('click', exportStrategyForServer);

    $('#connectApiBtn').addEventListener('click', connectApi);
    $('#disconnectApiBtn').addEventListener('click', disconnectApi);
    $('#startBotBtn').addEventListener('click', startBot);
    $('#stopBotBtn').addEventListener('click', stopBot);
    $('#closeBtn').addEventListener('click', manualClose);
    $('#longBtn')?.addEventListener('click', () => manualOpen('LONG'));
    $('#shortBtn')?.addEventListener('click', () => manualOpen('SHORT'));
    $('#resetBtn')?.addEventListener('click', resetWallet);

    const macdLineFilterEl = $('#useMacdLineFilter');
    if (macdLineFilterEl) {
      macdLineFilterEl.addEventListener('change', () => {
        updateMacdLineFilterUi();
        updateChartIndicatorButtons();
        scheduleBacktest(lastCandles);
        updateUI();
      });
    }

    $('#useMacd')?.addEventListener('change', () => {
      readFormSettings();
      if (!isStrategyUsingMacd()) chartIndicators.macd = false;
      syncChartIndicators();
      scheduleBacktest(lastCandles);
    });

    const rsiEntryFilterEl = $('#useRsiEntryFilter');
    if (rsiEntryFilterEl) {
      rsiEntryFilterEl.addEventListener('change', () => {
        updateRsiEntryFilterUi();
        scheduleBacktest(lastCandles);
        updateUI();
      });
    }

    const swingLevelsEl = $('#useSwingLevels');
    if (swingLevelsEl) {
      swingLevelsEl.addEventListener('change', () => {
        updateSwingLevelsUi();
        scheduleBacktest(lastCandles);
        updateUI();
      });
    }

    const swingStopEl = $('#useSwingStopLoss');
    if (swingStopEl) {
      swingStopEl.addEventListener('change', () => {
        updateSwingLevelsUi();
        scheduleBacktest(lastCandles);
        updateUI();
      });
    }

    const showSwingOnChartEl = $('#showSwingOnChart');
    if (showSwingOnChartEl) {
      showSwingOnChartEl.addEventListener('change', () => {
        updateSwingLevelsUi();
        scheduleBacktest(lastCandles);
        updateUI();
      });
    }

    ['stopLoss', 'takeProfit', 'stopLossPrice', 'takeProfitPrice'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const onSlTpChange = () => {
        readFormSettings();
        if (hasOpenPosition()) {
          syncOpenPositionSlTp();
        } else {
          updateSignalDisplay();
        }
        scheduleBacktest(lastCandles);
        updateUI();
      };
      el.addEventListener('change', onSlTpChange);
      el.addEventListener('input', onSlTpChange);
    });

    ['leverage', 'emaFast', 'emaSlow', 'useMacd', 'macdFast', 'macdSlow', 'macdSignal',
      'useMacdLineFilter', 'macdLongMin', 'macdShortMax',
      'useRsiEntryFilter', 'rsiLongMin', 'rsiShortMax',
      'useSwingLevels', 'showSwingOnChart', 'useSwingStopLoss', 'swingStopBufferPct',
      'swingPivotBars', 'swingLookback', 'showSwingOnChart',
      'riskPerTrade', 'maxAccountLoss',
      'rsiOversold', 'rsiOverbought', 'rsiPeriod', 'allowShort'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const onChange = () => {
        scheduleBacktest(lastCandles);
        if (['emaFast', 'emaSlow'].includes(id) && chartIndicators.ema) {
          syncChartIndicators();
        }
        if (id === 'useMacd' || id === 'useMacdLineFilter') {
          readFormSettings();
          if (!isStrategyUsingMacd()) chartIndicators.macd = false;
          syncChartIndicators();
        }
        if (['riskPerTrade', 'maxAccountLoss', 'leverage',
          'useMacdLineFilter', 'macdLongMin', 'macdShortMax',
          'useRsiEntryFilter', 'rsiLongMin', 'rsiShortMax',
          'useSwingLevels', 'showSwingOnChart', 'useSwingStopLoss', 'swingStopBufferPct',
          'swingPivotBars', 'swingLookback', 'swingNearPct', 'swingMode'].includes(id)) {
          if (id === 'useMacdLineFilter') updateMacdLineFilterUi();
          if (id === 'useRsiEntryFilter') updateRsiEntryFilterUi();
          if (['useSwingLevels', 'showSwingOnChart', 'useSwingStopLoss', 'swingStopBufferPct',
            'swingPivotBars', 'swingLookback', 'swingNearPct', 'swingMode'].includes(id)) {
            updateSwingLevelsUi();
          }
          updateUI();
        }
      };
      el.addEventListener('change', onChange);
      el.addEventListener('input', onChange);
    });

    updateUI();
  }

  return {
    init,
    getSettings,
    getFormStateForAi,
    getMarketContextForAi,
    getBacktestSnapshotForAi,
    applyStrategySettings,
    updateStrategyRulesDisplay,
    exportStrategyForServer,
  };
})();

function bootFuturesBotApp() {
  FuturesBotApp.init();
}

window.FuturesBotApp = FuturesBotApp;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFuturesBotApp);
} else {
  bootFuturesBotApp();
}
