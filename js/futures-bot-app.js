/* Futures auto-trading — [그룹3: 전략+봇+GPT+리스크+진입조건]
 * 차트([그룹1])와는 오직 ModuleBridge.chart 포트로만 통신한다.
 * 차트 코드 오류는 포트에서 격리되어 이 모듈은 절대 중단되지 않는다. */
const FuturesBotApp = (() => {
  const Chart = ModuleBridge.chart;
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
  let serverBotLive = true;
  let serverBotDryWarned = false;
  let lastServerBotLogLine = '';
  let seenServerBotLogs = new Set();
  let serverEntryGate = null;
  let statusPollTimer = null;
  let lastCandles = [];
  let testnetStatus = null;
  let showBacktest = true;
  let backtestHistoryExpandId = 0;
  const chartIndicators = { ema: false, rsi: false, macd: false };
  let sessionStartEquity = 0;
  let positionStopPrice = null;
  let positionTakeProfitPrice = null;
  const POS_SLTP_STORAGE_KEY = 'crypto-charts-pos-sltp';
  let liveExitBusy = false;
  let autoEntryBusy = false;
  let lastAutoEntryKey = null;
  let autoEntryRetryAt = 0;
  let lastSkipLogKey = null;
  // Pause/manual-close block state lives in the EntryPause module (js/entry-pause.js).
  let manualCloseBusy = false;
  let slTpConfirmed = false;
  let lastPendingSide = 'LONG';
  // Preview lines stay visible while the user is actively setting SL/TP
  // (recent drag/edit/confirm); otherwise they are cleared when flat.
  let slTpPreviewTouchedAt = 0;
  const SLTP_PREVIEW_TTL_MS = 2 * 60_000;

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
    useStopLoss: true,
    slTpMode: 'pct',
    pollSeconds: 60,
    backtestTradeCount: BACKTEST_TRADES_DEFAULT,
    lastPrice: 0,
    entryRules: null,
    exitRules: null,
    strategySlots: [],
  };

  const ENTRY_RULES_KEY = 'crypto-charts-entry-rules';
  const STRATEGY_SLOTS_KEY = 'crypto-charts-strategy-slots';
  const MAX_STRATEGY_SLOTS = 6;

  function loadStrategySlots() {
    try {
      const raw = localStorage.getItem(STRATEGY_SLOTS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return parsed
        .filter((s) => s && typeof s === 'object')
        .slice(0, MAX_STRATEGY_SLOTS)
        .map((s, i) => {
          const rawEntry = s.entryRules ?? s.rules ?? null;
          return {
            id: s.id ?? `slot-${Date.now()}-${i}`,
            name: String(s.name || `조건 ${i + 1}`).slice(0, 30),
            enabled: s.enabled !== false,
            entryRules: rawEntry
              ? (window.StrategyEngine?.sanitizeEntryRules?.(rawEntry) ?? rawEntry)
              : null,
            exitRules: s.exitRules ?? null,
          };
        });
    } catch {
      return null;
    }
  }

  function saveStrategySlots() {
    try {
      localStorage.setItem(STRATEGY_SLOTS_KEY, JSON.stringify(state.strategySlots));
    } catch { /* ignore */ }
  }

  function newSlotId() {
    return `slot-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  // One-time migration: the old single entryRules becomes slot 1 so existing
  // strategies keep working when the multi-slot UI takes over.
  function migrateLegacyRulesToSlots() {
    const legacy = loadStrategyStorage();
    const slots = loadStrategySlots();
    if (slots && slots.length) {
      state.strategySlots = slots;
      const anySignals = slots.some((s) => entryRulesHaveSignals(s.entryRules));
      if (!anySignals && legacy.entryRules) {
        const target = slots.find((s) => s.enabled !== false) || slots[0];
        if (target) {
          target.entryRules = legacy.entryRules;
          target.exitRules = legacy.exitRules ?? target.exitRules;
          target.enabled = true;
          saveStrategySlots();
        }
      }
      syncStateEntryRulesFromSlots();
      return;
    }
    if (legacy.entryRules) {
      state.strategySlots = [{
        id: newSlotId(),
        name: '조건 1',
        enabled: true,
        entryRules: legacy.entryRules,
        exitRules: legacy.exitRules,
      }];
      saveStrategySlots();
    } else {
      state.strategySlots = [];
    }
    syncStateEntryRulesFromSlots();
  }

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

  function primaryEntryRulesFromState() {
    const slot = (state.strategySlots || []).find(
      (s) => s.enabled !== false && s.entryRules,
    );
    return slot?.entryRules ?? state.entryRules;
  }

  function syncStateEntryRulesFromSlots() {
    const slot = (state.strategySlots || []).find(
      (s) => s.enabled !== false && entryRulesHaveSignals(s.entryRules),
    );
    if (!slot) return;
    state.entryRules = slot.entryRules
      ? (StrategyEngine.sanitizeEntryRules?.(slot.entryRules) ?? slot.entryRules)
      : null;
    if (slot.exitRules != null) {
      state.exitRules = StrategyEngine.sanitizeExitRules
        ? StrategyEngine.sanitizeExitRules(slot.exitRules)
        : slot.exitRules;
    }
    saveStrategyStorage(state.entryRules, state.exitRules);
  }

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
      useStopLoss: true,
      entryRules: primaryEntryRulesFromState(),
      exitRules: state.exitRules,
      strategySlots: state.strategySlots?.length ? state.strategySlots : undefined,
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
      useStopLoss: true,
      rsiPeriod: s.rsiPeriod,
      rsiOversold: s.rsiOversold,
      rsiOverbought: s.rsiOverbought,
      entryRules: s.entryRules,
      exitRules: s.exitRules,
      strategySlots: s.strategySlots,
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

  function getFormStateForAi(targetSlotId = null) {
    readFormSettings();
    // GPT 편집의 기준이 되는 entryRules: 저장 대상 슬롯이 선택돼 있으면 그
    // 슬롯의 규칙을 현재 전략으로 보여줘 follow-up 수정이 그 슬롯에 적용된다.
    let entryRules = state.entryRules;
    let exitRules = state.exitRules;
    if (targetSlotId && targetSlotId !== '__new__') {
      const slot = (state.strategySlots || []).find((s) => s.id === targetSlotId);
      if (slot) {
        entryRules = slot.entryRules ?? null;
        exitRules = slot.exitRules ?? null;
      }
    } else if (targetSlotId === '__new__') {
      entryRules = null;
      exitRules = null;
    }
    return {
      symbol: state.symbol,
      interval: state.interval,
      rsiPeriod: state.rsiPeriod,
      rsiOversold: state.rsiOversold,
      rsiOverbought: state.rsiOverbought,
      stopLossPct: state.stopLossPct,
      takeProfitPct: state.takeProfitPct,
      useStopLoss: state.useStopLoss !== false,
      allowShort: state.allowShort,
      leverage: state.leverage,
      riskPerTradePct: state.riskPerTradePct,
      maxAccountLossPct: state.maxAccountLossPct,
      pollSeconds: state.pollSeconds,
      entryRules,
      exitRules,
      strategySlotTarget: targetSlotId,
      strategySlots: (state.strategySlots || []).map((s) => ({
        id: s.id,
        name: s.name,
        enabled: s.enabled !== false,
        entryRules: s.entryRules ?? null,
        exitRules: s.exitRules ?? null,
      })),
      indicatorCatalog: window.StrategyEngine?.catalogForAi?.() || '',
    };
  }

  function getMarketContextForAi() {
    readFormSettings();
    syncFromChart();
    const candles = lastCandles.length ? lastCandles : (Chart.getCandles() || []);
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

    const rangeHigh = Math.max(...candles.slice(-lookback).map((c) => c.high));
    const rangeLow = Math.min(...candles.slice(-lookback).map((c) => c.low));
    const ctx = {
      symbol: state.symbol,
      interval: state.interval,
      candleCount: candles.length,
      price: Math.round(price * 100) / 100,
      change24BarsPct: Math.round(changePct * 100) / 100,
      rsi14: rsi14 != null ? Math.round(rsi14 * 10) / 10 : null,
      last20Bars: { up: upBars, down: Math.max(0, last20.length - 1 - upBars) },
      // Range extremes of last N bars — NOT swing pivots. Use structure.swings for 전고점/전저점.
      recentHigh: rangeHigh,
      recentLow: rangeLow,
      recentRangeNote: 'recentHigh/recentLow = simple max/min of last ~24 bars. NOT confirmed swing highs/lows. For 전고점/전저점 ALWAYS use structure.swings.',
    };

    if (window.ChartStructure?.analyzeForAi) {
      const structure = ChartStructure.analyzeForAi(candles, { recentCount: 15, fvgLookback: 30 });
      ctx.recentCandles15 = structure.recentCandles;
      ctx.structure = {
        swings: structure.swings,
        fvg: structure.fvg,
        divergence: structure.divergence,
      };
    }

    ctx.timeframe = timeframeInfoForAi(state.interval);

    const hovered = window.CandleTooltip?.getLastHovered?.();
    if (hovered && hovered.hoveredAgoSec <= 300) {
      ctx.hoveredCandle = hovered;
    }

    return ctx;
  }

  const INTERVAL_MINUTES = {
    '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
    '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720,
    '1d': 1440, '1w': 10080,
  };

  function timeframeInfoForAi(interval) {
    const minutes = INTERVAL_MINUTES[interval] || null;
    if (!minutes) return { interval };
    const perHour = 60 / minutes;
    const perDay = 1440 / minutes;
    return {
      interval,
      minutesPerCandle: minutes,
      candlesPerHour: perHour >= 1 ? Math.round(perHour * 100) / 100 : null,
      candlesPerDay: perDay >= 1 ? Math.round(perDay * 100) / 100 : null,
      note: `현재 차트는 ${interval}봉. 1시간=${perHour >= 1 ? Math.round(perHour) : '<1'}개, 1일=${perDay >= 1 ? Math.round(perDay) : '<1'}개 캔들. "지난 X시간" 요청은 X*${perHour >= 1 ? Math.round(perHour) : 1}개 캔들로 환산.`,
    };
  }

  function getBacktestSnapshotForAi() {
    readFormSettings();
    syncFromChart();
    const raw = lastCandles.length ? lastCandles : (Chart.getCandles() || []);
    const candles = BacktestRunner.closedCandlesOnly(raw, state.interval);
    const settings = getSettings();
    const targetTrades = state.backtestTradeCount || BACKTEST_TRADES_DEFAULT;

    if (!candles.length || !window.FuturesStrategy?.backtest) {
      return { current: null, targetTrades, candlesUsed: 0 };
    }

    const snap = BacktestRunner.snapshotFromCandles(candles, settings, targetTrades, state.interval);
    return {
      ...snap,
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
    if (id === 'riskPerTrade') syncRiskPerTradeLabel();
  }

  function syncRiskPerTradeLabel() {
    const el = $('#riskPerTradeVal');
    const slider = $('#riskPerTrade');
    if (!el || !slider) return;
    const pct = parseFloat(slider.value);
    el.textContent = Number.isFinite(pct) ? `${pct % 1 === 0 ? pct : pct.toFixed(1)}%` : '—';
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
      const slots = state.strategySlots || [];
      const lines = [];
      if (slots.length) {
        slots.forEach((slot) => {
          if (!slot.entryRules) {
            lines.push(`· <strong>[${slot.enabled ? 'ON' : 'OFF'}] ${escapeHtml(slot.name)}</strong>: 비어 있음 — GPT로 전략을 저장하세요`);
            return;
          }
          const rules = StrategyEngine.sanitizeEntryRules(slot.entryRules);
          const badge = slot.enabled ? 'ON' : 'OFF';
          const exitHint = slot.exitRules ? ' · 동적 SL/TP' : '';
          lines.push(`· <strong>[${badge}] ${escapeHtml(slot.name)}</strong>: ${StrategyEngine.rulesSummary(rules)}${exitHint}`);
        });
      } else {
        const rules = StrategyEngine.normalizeRules(s);
        lines.push(`· <strong>롱/숏 조건</strong>: ${StrategyEngine.rulesSummary(rules)}`);
        const exitHint = formatExitRulesSummary(s.exitRules);
        if (exitHint) lines.push(exitHint);
      }
      lines.push(`· 손절 -${s.stopLossPct}% · 익절 +${s.takeProfitPct}% (진입가 기준, 동적 SL/TP 우선)`);
      lines.push('· 차트에 지표를 켜지 않아도 자동 계산됩니다');
      el.innerHTML = lines.filter(Boolean).join('<br>\n');
      updateSlTpStrategyHint();
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
    updateSlTpStrategyHint();
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

  // ── 진입 조건 슬롯 패널 ─────────────────────────────────────────────

  function getStrategySlots() {
    return state.strategySlots || [];
  }

  function recomputeAfterSlotsChange() {
    readFormSettings();
    BacktestRunner.clearHistoryCache();
    updateStrategyRulesDisplay();
    updateChartIndicatorButtons();
    invalidateBacktestChart(lastCandles, { message: '백테스트: 진입 조건 변경 — 재계산 중...' });
    applyBacktest(lastCandles, { force: true, focusChart: true });
    updateSignalDisplay();
    scheduleServerStrategySync();
    updateUI();
  }

  function onStrategySlotsChanged({ recompute = true } = {}) {
    saveStrategySlots();
    renderStrategySlotsPanel();
    updateStrategyAiSlotOptions();
    if (recompute) recomputeAfterSlotsChange();
    else updateStrategyRulesDisplay();
  }

  function addStrategySlot({ name = null, entryRules = null, exitRules = null, enabled = true } = {}) {
    if (state.strategySlots.length >= MAX_STRATEGY_SLOTS) {
      addLog(`진입 조건은 최대 ${MAX_STRATEGY_SLOTS}개까지 만들 수 있습니다.`, 'warn');
      return null;
    }
    const slot = {
      id: newSlotId(),
      name: name || `조건 ${state.strategySlots.length + 1}`,
      enabled,
      entryRules,
      exitRules,
    };
    state.strategySlots.push(slot);
    return slot;
  }

  function slotRulesSummaryText(slot) {
    if (!slot.entryRules) return '비어 있음 — GPT로 전략을 저장하세요';
    try {
      const rules = StrategyEngine.sanitizeEntryRules(slot.entryRules);
      return StrategyEngine.rulesSummary(rules);
    } catch {
      return '규칙 해석 실패';
    }
  }

  function renderStrategySlotsPanel() {
    const list = $('#strategySlotsList');
    if (!list) return;
    list.innerHTML = '';

    if (!state.strategySlots.length) {
      const empty = document.createElement('div');
      empty.className = 'strategy-slot-empty';
      empty.textContent = '진입 조건이 없습니다. "+ 조건 추가"를 누르거나 GPT에게 전략을 설명하세요. (조건이 없으면 기본 RSI 전략이 사용됩니다)';
      list.appendChild(empty);
      return;
    }

    state.strategySlots.forEach((slot) => {
      const row = document.createElement('div');
      row.className = `strategy-slot${slot.enabled ? '' : ' strategy-slot--off'}`;
      row.dataset.slotId = slot.id;

      const toggle = document.createElement('label');
      toggle.className = 'strategy-slot__toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = slot.enabled;
      checkbox.title = '이 진입 조건 사용 on/off';
      checkbox.addEventListener('change', () => {
        slot.enabled = checkbox.checked;
        addLog(`진입 조건 [${slot.name}] ${slot.enabled ? 'ON' : 'OFF'}`, 'info');
        onStrategySlotsChanged();
      });
      toggle.appendChild(checkbox);

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'strategy-slot__name';
      nameInput.value = slot.name;
      nameInput.maxLength = 30;
      nameInput.title = '조건 이름 (클릭해서 수정)';
      nameInput.addEventListener('change', () => {
        slot.name = nameInput.value.trim() || slot.name;
        nameInput.value = slot.name;
        onStrategySlotsChanged({ recompute: false });
      });

      const summary = document.createElement('div');
      summary.className = 'strategy-slot__summary';
      summary.textContent = slotRulesSummaryText(slot);
      summary.title = summary.textContent;

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'strategy-slot__delete';
      delBtn.textContent = '✕';
      delBtn.title = '이 진입 조건 삭제';
      delBtn.addEventListener('click', () => {
        if (!confirm(`진입 조건 [${slot.name}]을(를) 삭제할까요?`)) return;
        state.strategySlots = state.strategySlots.filter((s) => s.id !== slot.id);
        addLog(`진입 조건 [${slot.name}] 삭제됨`, 'info');
        onStrategySlotsChanged();
      });

      row.appendChild(toggle);
      row.appendChild(nameInput);
      row.appendChild(summary);
      row.appendChild(delBtn);
      list.appendChild(row);
    });
  }

  // GPT 채팅의 "저장할 진입 조건" 드롭다운을 현재 슬롯 목록과 동기화한다.
  function updateStrategyAiSlotOptions() {
    const select = $('#strategyAiTargetSlot');
    if (!select) return;
    const prev = select.value;
    select.innerHTML = '';

    state.strategySlots.forEach((slot) => {
      const opt = document.createElement('option');
      opt.value = slot.id;
      opt.textContent = `${slot.name}${slot.enabled ? '' : ' (OFF)'}`;
      select.appendChild(opt);
    });

    const optNew = document.createElement('option');
    optNew.value = '__new__';
    optNew.textContent = '+ 새 조건으로 저장';
    select.appendChild(optNew);

    if (prev && [...select.options].some((o) => o.value === prev)) {
      select.value = prev;
    } else if (state.strategySlots.length) {
      select.value = state.strategySlots[0].id;
    } else {
      select.value = '__new__';
    }
  }

  function entryRulesHaveSignals(rules) {
    if (!rules || !window.StrategyEngine?.sanitizeEntryRules) return false;
    const s = StrategyEngine.sanitizeEntryRules(rules);
    return (s.long.enabled && s.long.conditions.length > 0)
      || (s.short.enabled && s.short.conditions.length > 0);
  }

  // getSettings() returns live state.strategySlots by reference — compare keys
  // only after a deep snapshot or in-place slot edits look unchanged.
  function snapshotSettingsForCacheKey(settings) {
    try {
      return JSON.parse(JSON.stringify(settings));
    } catch {
      return settings;
    }
  }

  function normalizeIncomingSlot(raw, index = 0) {
    const rawEntry = raw?.entryRules ?? raw?.rules ?? null;
    let entryRules = null;
    if (rawEntry) {
      entryRules = StrategyEngine.sanitizeEntryRules?.(rawEntry) ?? rawEntry;
    }
    return {
      id: raw?.id || newSlotId(),
      name: String(raw?.name || `조건 ${index + 1}`).slice(0, 30),
      enabled: raw?.enabled !== false,
      entryRules,
      exitRules: raw?.exitRules ?? null,
    };
  }

  function mergeStrategySlotsPatch(existingSlots, patchSlots) {
    if (!Array.isArray(patchSlots) || !patchSlots.length) return existingSlots || [];
    const merged = (existingSlots || []).map((s) => ({ ...s }));
    const indexById = new Map(merged.map((s, i) => [s.id, i]));

    patchSlots.forEach((raw, pi) => {
      const incoming = normalizeIncomingSlot(raw, pi);
      const idx = incoming.id && indexById.has(incoming.id) ? indexById.get(incoming.id) : -1;
      if (idx >= 0) {
        const prev = merged[idx];
        const nextEntry = incoming.entryRules && entryRulesHaveSignals(incoming.entryRules)
          ? incoming.entryRules
          : prev.entryRules;
        merged[idx] = {
          ...prev,
          name: incoming.name || prev.name,
          enabled: incoming.enabled,
          entryRules: nextEntry,
          exitRules: incoming.exitRules != null ? incoming.exitRules : prev.exitRules,
        };
        return;
      }
      if (merged.length >= MAX_STRATEGY_SLOTS) return;
      if (incoming.entryRules && !entryRulesHaveSignals(incoming.entryRules)) return;
      merged.push(incoming);
      indexById.set(incoming.id, merged.length - 1);
    });
    return merged;
  }

  function resolveTargetStrategySlot(targetSlotId) {
    if (targetSlotId && targetSlotId !== '__new__') {
      return (state.strategySlots || []).find((s) => s.id === targetSlotId) || null;
    }
    if (state.strategySlots.length === 1) return state.strategySlots[0];
    const selected = $('#strategyAiTargetSlot')?.value;
    if (selected && selected !== '__new__') {
      return state.strategySlots.find((s) => s.id === selected) || null;
    }
    return state.strategySlots.find((s) => s.enabled !== false) || state.strategySlots[0] || null;
  }

  function applyStrategySettings(settings, {
    rulesHtml = null, summary = null, changedFields = [], targetSlotId = null, patch = null,
  } = {}) {
    if (!settings) return { applied: false, reason: '적용할 설정이 없습니다.' };

    const patchObj = patch && typeof patch === 'object' ? patch : null;
    const patchKeys = patchObj ? Object.keys(patchObj) : [];
    const changed = new Set(Array.isArray(changedFields) ? changedFields : []);
    const touches = (key) => changed.has(key)
      || (patchObj && Object.prototype.hasOwnProperty.call(patchObj, key));

    // GPT가 changed_fields만 채우고 실제 patch가 비어 있으면(이해 못함·질문)
    // 설정·백테스트 캐시를 건드리지 않는다.
    if (!patchKeys.length) {
      if (changed.size > 0) {
        addLog('AI 응답에 실제 변경 내용이 없어 기존 설정과 백테스트를 유지합니다.', 'info');
      }
      return { applied: false };
    }

    readFormSettings();
    const prevSnapshot = snapshotSettingsForCacheKey(getSettings());
    const prevCacheKey = getBacktestCacheKey(prevSnapshot);

    if (touches('rsiPeriod')) setFieldValue('rsiPeriod', settings.rsiPeriod);
    if (touches('rsiOversold')) setFieldValue('rsiOversold', settings.rsiOversold);
    if (touches('rsiOverbought')) setFieldValue('rsiOverbought', settings.rsiOverbought);
    if (touches('stopLossPct')) setFieldValue('stopLoss', settings.stopLossPct);
    if (touches('takeProfitPct')) setFieldValue('takeProfit', settings.takeProfitPct);
    const pctSlTpChanged = touches('stopLossPct') || touches('takeProfitPct');
    const slTpChanged = pctSlTpChanged || touches('exitRules');
    if (pctSlTpChanged && state.slTpMode !== 'pct') {
      setSlTpMode('pct');
      addLog('AI가 SL/TP를 %기준으로 설정 — SL/TP 입력 방식을 % 비율로 전환했습니다.', 'info');
    }
    if (touches('leverage')) setFieldValue('leverage', settings.leverage);
    if (touches('riskPerTradePct')) setFieldValue('riskPerTrade', settings.riskPerTradePct);
    if (touches('maxAccountLossPct')) setFieldValue('maxAccountLoss', settings.maxAccountLossPct);
    if (touches('pollSeconds')) setFieldValue('pollSeconds', settings.pollSeconds);
    if (touches('allowShort')) setFieldValue('allowShort', settings.allowShort);

    readFormSettings();
    if (touches('allowShort')) {
      if (settings.allowShort === false) state.allowShort = false;
      else if (settings.allowShort === true) state.allowShort = true;
    }

    let entryRulesRejected = false;
    if (touches('entryRules')) {
      const prevHadSignals = entryRulesHaveSignals(prevSnapshot.entryRules)
        || (prevSnapshot.strategySlots || []).some((slot) => slot.enabled !== false
          && entryRulesHaveSignals(slot.entryRules));
      const nextRules = settings.entryRules
        ? StrategyEngine.sanitizeEntryRules(settings.entryRules)
        : null;
      if (settings.entryRules && !entryRulesHaveSignals(nextRules)
        && (prevHadSignals || targetSlotId === '__new__')) {
        entryRulesRejected = true;
        const rejectReason = '진입 조건이 비어 있거나 시스템이 이해할 수 없는 형식입니다. 지표·캔들·롱/숏 방향과 수치를 포함해 다시 설명해 주세요.';
        addLog(`AI가 보낸 진입 조건이 비어 있거나 잘못되어 기존 조건을 유지합니다.`, 'warn');
        if (touches('entryRules') && (targetSlotId === '__new__' || !prevHadSignals)) {
          return { applied: false, reason: rejectReason };
        }
      } else {
        state.entryRules = nextRules;
      }
    }
    if (touches('exitRules')) {
      state.exitRules = settings.exitRules
        ? (StrategyEngine.sanitizeExitRules
          ? StrategyEngine.sanitizeExitRules(settings.exitRules)
          : settings.exitRules)
        : null;
      const exitSlot = resolveTargetStrategySlot(targetSlotId);
      if (exitSlot) {
        exitSlot.exitRules = state.exitRules;
        saveStrategySlots();
      }
    }

    if (state.entryRules && StrategyEngine.validateEntryRules) {
      const { warnings } = StrategyEngine.validateEntryRules(state.entryRules);
      warnings.forEach((w) => addLog(`전략 경고: ${w}`, 'warn'));
    }
    saveStrategyStorage(state.entryRules, state.exitRules);

    if (touches('strategySlots') && Array.isArray(settings.strategySlots)) {
      state.strategySlots = mergeStrategySlotsPatch(state.strategySlots, settings.strategySlots);
      saveStrategySlots();
      renderStrategySlotsPanel();
      updateStrategyAiSlotOptions();
    }

    // entryRules-only patch: write into the target slot after slot merge so it wins.
    if (touches('entryRules') && settings.entryRules && !entryRulesRejected) {
      let slot = resolveTargetStrategySlot(targetSlotId);
      if (!slot && targetSlotId === '__new__') slot = addStrategySlot();
      else if (!slot && !state.strategySlots.length) slot = addStrategySlot();
      if (slot && entryRulesHaveSignals(state.entryRules)) {
        slot.entryRules = state.entryRules;
        if (touches('exitRules')) slot.exitRules = state.exitRules;
        slot.enabled = true;
        addLog(`진입 조건 [${slot.name}]에 전략이 저장되었습니다.`, 'info');
        saveStrategySlots();
        renderStrategySlotsPanel();
        updateStrategyAiSlotOptions();
      }
    }

    syncStateEntryRulesFromSlots();

    readFormSettings();
    const nextCacheKey = getBacktestCacheKey(getSettings());
    const entryRulesTouched = touches('entryRules') && !entryRulesRejected;
    const rulesTouched = entryRulesTouched || touches('exitRules') || touches('strategySlots');
    const strategyChanged = nextCacheKey !== prevCacheKey || rulesTouched;

    updateStrategyRulesDisplay(settings, rulesHtml);
    updateChartIndicatorButtons();

    if (strategyChanged) {
      BacktestRunner.clearHistoryCache();
      invalidateBacktestChart(lastCandles, { message: '백테스트: 진입 조건 변경 — 재계산 중...' });
      applyBacktest(lastCandles, { force: true, focusChart: true });
    }
    // strategyChanged가 false면 BacktestRunner 캐시·진행 중 로드를 유지한다.
    // 예전에는 GPT가 SL/TP만 바꿔도(또는 이해 못하고 patch 없이
    // changed_fields만 보내도) 캐시를 지워 100회 로딩이 처음부터 다시 시작됐다.

    updateSignalDisplay();
    updateUI();

    const note = summary || 'AI가 전략 설정을 적용했습니다.';
    const changedLabel = Array.isArray(changedFields) && changedFields.length
      ? ` · 변경: ${changedFields.join(', ')}`
      : '';
    addLog(`${note}${changedLabel}`, 'info');

    if (slTpChanged && !hasOpenPosition()) {
      slTpPreviewTouchedAt = Date.now();
      autoConfirmSlTpFromStrategy({ log: true });
      syncPreviewFromLastSignal();
    }
    scheduleServerStrategySync();
    return { applied: true };
  }

  function resetSlTpConfirm() {
    slTpConfirmed = false;
    updateConfirmSlTpUi();
    updateSlTpStrategyHint();
  }

  function strategySlTpReady(side = lastPendingSide || 'LONG') {
    readFormSettings();
    if (state.useStopLoss !== false && !(state.stopLossPct > 0)) return false;
    if (!(state.takeProfitPct > 0) && !state.exitRules) return false;
    const entryPrice = state.lastPrice || lastCandles.at(-1)?.close;
    if (!entryPrice) {
      return state.stopLossPct > 0 && state.takeProfitPct > 0;
    }
    const levels = calcEntryLevels(side, entryPrice);
    if (!levels?.takeProfitPrice) return false;
    if (state.useStopLoss !== false && levels.stopPrice == null) return false;
    return true;
  }

  function autoConfirmSlTpFromStrategy({ log = false } = {}) {
    if (hasOpenPosition()) {
      slTpConfirmed = true;
      updateSlTpStrategyHint();
      return true;
    }
    if (!strategySlTpReady()) {
      slTpConfirmed = false;
      updateSlTpStrategyHint();
      return false;
    }
    slTpConfirmed = true;
    updateConfirmSlTpUi();
    updateSlTpStrategyHint();
    if (log) {
      const side = lastPendingSide || 'LONG';
      const entryPrice = state.lastPrice || lastCandles.at(-1)?.close;
      const levels = calcEntryLevels(side, entryPrice);
      const slNote = levels?.stopPrice != null
        ? `SL $${levels.stopPrice.toFixed(2)} · `
        : '';
      addLog(`전략 SL/TP 적용 — ${slNote}TP $${levels?.takeProfitPrice?.toFixed(2) ?? '—'}`, 'info');
    }
    return true;
  }

  function updateSlTpStrategyHint() {
    const hint = $('#slTpStrategyHint');
    if (!hint) return;
    readFormSettings();
    const exitHint = formatExitRulesSummary(state.exitRules);
    if (exitHint) {
      hint.textContent = `동적 SL/TP — ${exitHint}`;
      return;
    }
    if (strategySlTpReady()) {
      hint.textContent = `SL -${state.stopLossPct}% · TP +${state.takeProfitPct}% (AI 전략)`;
      return;
    }
    hint.textContent = 'AI에게 SL/TP를 포함한 전략을 설정해 주세요.';
  }

  function confirmSlTp() {
    if (hasOpenPosition()) return;
    readFormSettings();
    const side = lastPendingSide;
    const entryPrice = state.lastPrice || lastCandles.at(-1)?.close;
    const levels = calcEntryLevels(side, entryPrice);
    if (!levels?.takeProfitPrice) {
      addLog('SL/TP 확인 실패: 익절(TP) 가격 계산 불가', 'loss');
      return;
    }
    slTpConfirmed = true;
    slTpPreviewTouchedAt = Date.now();
    updateConfirmSlTpUi();
    const slNote = levels.stopPrice != null
      ? `SL $${levels.stopPrice.toFixed(2)} · `
      : '';
    addLog(`SL/TP 확인 — ${slNote}TP $${levels.takeProfitPrice.toFixed(2)}`, 'info');
    scheduleServerStrategySync();
  }

  function updateConfirmSlTpUi() {
    const btn = $('#confirmSlTpBtn');
    const hint = $('#slTpConfirmHint');
    if (!btn) return;
    if (hasOpenPosition()) {
      btn.disabled = true;
      btn.textContent = '포지션 보유 중';
      btn.className = 'btn btn--ghost btn--block btn--sm';
      if (hint) hint.textContent = '청산 후 다음 진입 전 SL/TP를 다시 확인하세요.';
      return;
    }
    btn.disabled = false;
    if (slTpConfirmed) {
      btn.textContent = 'SL/TP 확인됨 ✓';
      btn.className = 'btn btn--ghost btn--block btn--sm';
      if (hint) hint.textContent = '확인 완료 — 봇/수동 진입 시 이 SL/TP가 적용됩니다.';
    } else {
      btn.textContent = 'SL/TP 확인';
      btn.className = 'btn btn--primary btn--block btn--sm';
      if (hint) hint.textContent = 'SL/TP를 설정한 뒤 확인 버튼을 눌러야 진입할 수 있습니다.';
    }
  }

  function syncPctFieldsFromPrices(side, entryPrice, stopPrice, takeProfitPrice) {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;
    if (Number.isFinite(stopPrice)) {
      const pct = side === 'LONG'
        ? ((entryPrice - stopPrice) / entryPrice) * 100
        : ((stopPrice - entryPrice) / entryPrice) * 100;
      setFieldValue('stopLoss', Math.max(0.1, pct).toFixed(2));
    }
    if (Number.isFinite(takeProfitPrice)) {
      const pct = side === 'LONG'
        ? ((takeProfitPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - takeProfitPrice) / entryPrice) * 100;
      setFieldValue('takeProfit', Math.max(0.1, pct).toFixed(2));
    }
  }

  // Push dragged/edited SL/TP to the exchange as real trigger orders. Debounced
  // because drag emits many updates per second; only the final level is sent.
  let exchangeSlTpTimer = null;
  function scheduleExchangeSlTpSync() {
    if (!isTestnetMode() || !testnetStatus?.position) return;
    clearTimeout(exchangeSlTpTimer);
    exchangeSlTpTimer = setTimeout(async () => {
      // Exchange values from the last status refresh = state before this edit.
      // The server cancels old orders before placing new ones, so on failure
      // we must re-register these to restore protection.
      const prevSl = testnetStatus?.position?.stopPrice ?? null;
      const prevTp = testnetStatus?.position?.takeProfitPrice ?? null;
      try {
        const r = await FuturesApiClient.setSlTp(
          state.useStopLoss === false ? null : positionStopPrice,
          positionTakeProfitPrice,
        );
        positionStopPrice = r.stopPrice ?? positionStopPrice;
        positionTakeProfitPrice = r.takeProfitPrice ?? positionTakeProfitPrice;
        addLog(
          `거래소 SL/TP 갱신 — SL $${positionStopPrice?.toFixed(2) ?? '—'} · TP $${positionTakeProfitPrice?.toFixed(2) ?? '—'}`,
          'info',
        );
        updatePositionOverlay();
      } catch (err) {
        addLog(`거래소 SL/TP 갱신 실패: ${err.message} — 이전 값으로 되돌립니다.`, 'loss');
        positionStopPrice = prevSl;
        positionTakeProfitPrice = prevTp;
        if (prevSl != null || prevTp != null) {
          try {
            await FuturesApiClient.setSlTp(prevSl, prevTp);
            addLog(`이전 SL/TP 복원 완료 — SL $${prevSl?.toFixed(2) ?? '—'} · TP $${prevTp?.toFixed(2) ?? '—'}`, 'info');
          } catch (restoreErr) {
            addLog(`이전 SL/TP 복원 실패: ${restoreErr.message} — 포지션을 직접 확인하세요.`, 'loss');
          }
        }
        await refreshTestnetStatus();
        updatePositionOverlay();
        updateUI();
      }
    }, 600);
  }

  // Reflect dragged prices back into the input fields of the ACTIVE mode so
  // the drag and the form always agree on the next entry's levels.
  function syncModeFieldsFromDrag(side, entryPrice, stopPrice, takeProfitPrice) {
    if (state.slTpMode === 'pnl') {
      const notional = estimatePlannedNotional();
      if (notional > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
        if (Number.isFinite(stopPrice)) {
          const pct = Math.abs(entryPrice - stopPrice) / entryPrice;
          setFieldValue('stopLossPnl', (notional * pct).toFixed(2));
        }
        if (Number.isFinite(takeProfitPrice)) {
          const pct = Math.abs(takeProfitPrice - entryPrice) / entryPrice;
          setFieldValue('takeProfitPnl', (notional * pct).toFixed(2));
        }
      }
      return;
    }
    syncPctFieldsFromPrices(side, entryPrice, stopPrice, takeProfitPrice);
  }

  function applySlTpDrag({ role, price, side, entryPrice, stopPrice, takeProfitPrice }) {
    readFormSettings();
    syncModeFieldsFromDrag(side, entryPrice, stopPrice, takeProfitPrice);
    readFormSettings();

    if (hasOpenPosition()) {
      positionStopPrice = stopPrice;
      positionTakeProfitPrice = takeProfitPrice;
      savePositionSlTpStorage(side, entryPrice, stopPrice, takeProfitPrice);
      if (!isTestnetMode()) {
        const pos = FuturesPaper.getPosition();
        if (pos) {
          pos.stopPrice = stopPrice;
          pos.takeProfitPrice = takeProfitPrice;
        }
      }
      updatePositionOverlay();
      scheduleExchangeSlTpSync();
    } else {
      lastPendingSide = side;
      slTpPreviewTouchedAt = Date.now();
      resetSlTpConfirm();
    }
  }

  // Pre-entry preview tracks the live price: the entry line follows the
  // current price and SL/TP keep their % distance from it (set via the %
  // fields or a drag, which syncs those fields). Absolute $ values would pin
  // the lines while price walks away, so they are recomputed every tick here.
  function calcTrackedPreviewLevels(side, entryPrice) {
    readFormSettings();
    const index = lastCandles.length ? lastCandles.length - 1 : null;
    return FuturesStrategy.calcEntryLevels(side, entryPrice, getSettings(), {
      candles: lastCandles,
      index,
    });
  }

  function syncPreviewSlTpOverlay(_result) {
    if (hasOpenPosition()) return;
    // 진입 전 차트 미리보기 없음 — 포지션 진입 후 updatePositionOverlay만 사용.
    Chart.clearPositionOverlay();
    Chart.clearSignalOverlay();
  }

  function syncPreviewFromLastSignal() {
    if (!lastCandles.length || hasOpenPosition()) return;
    readFormSettings();
    const settings = getSettings();
    const pos = isTestnetMode() ? testnetStatus?.position?.side : FuturesPaper.getPosition()?.side;
    const result = FuturesStrategy.analyze(lastCandles, settings, pos || null);
    syncPreviewSlTpOverlay(result);
  }

  function requireSlTpConfirmedForEntry() {
    if (hasOpenPosition() || slTpConfirmed) return true;
    if (autoConfirmSlTpFromStrategy()) return true;
    addLog('진입 보류: AI 전략에 SL/TP를 설정해 주세요.', 'info');
    return false;
  }

  // The server rolls an entry back (auto-closes the position) when exchange
  // SL/TP registration fails. When that happens, block all further trading:
  // stop the bot and drop the SL/TP confirmation so nothing can re-enter
  // until the user fixes the settings and presses the confirm button again.
  async function handleEntryError(err, label) {
    addLog(`${label} 진입 실패: ${err.message}`, 'loss');
    if (!String(err.message).includes('진입을 자동 취소')) return;
    resetSlTpConfirm();
    clearPositionStop();
    if (botRunning) {
      await stopBot();
      addLog('안전을 위해 봇을 정지했습니다.', 'loss');
    }
    addLog('거래가 차단되었습니다 — AI 전략의 SL/TP 설정을 확인해 주세요.', 'loss');
    await refreshTestnetStatus();
    updateUI();
  }

  const SLTP_MODE_KEY = 'crypto-charts-sltp-mode';
  const SLTP_MODE_HINTS = {
    pct: '진입가 대비 % 거리 — 진입 전 미리보기가 현재가를 따라갑니다.',
    pnl: '손익 금액(USDT) 기준 — 예상 포지션 규모로 %를 환산하며 현재가를 따라갑니다.',
  };

  function getSlTpMode() {
    const active = document.querySelector('#slTpModePicker [data-sltp-mode].active');
    const mode = active?.dataset.sltpMode || 'pct';
    return SLTP_MODE_HINTS[mode] ? mode : 'pct';
  }

  function setSlTpMode(mode, { persist = true } = {}) {
    if (!SLTP_MODE_HINTS[mode]) mode = 'pct';
    const picker = $('#slTpModePicker');
    if (!picker) return;
    picker.querySelectorAll('[data-sltp-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.sltpMode === mode);
    });
    $('#slTpPctRow')?.classList.toggle('hidden', mode !== 'pct');
    $('#slTpPnlRow')?.classList.toggle('hidden', mode !== 'pnl');
    const hint = $('#slTpModeHint');
    if (hint) hint.textContent = SLTP_MODE_HINTS[mode];
    if (persist) localStorage.setItem(SLTP_MODE_KEY, mode);
    state.slTpMode = mode;
  }

  function calcEntryLevels(side, price = state.lastPrice || lastCandles.at(-1)?.close) {
    readFormSettings();
    if (!price || !side) return null;
    const index = lastCandles.length ? lastCandles.length - 1 : null;
    return FuturesStrategy.calcEntryLevels(side, price, getSettings(), {
      candles: lastCandles,
      index,
    });
  }

  function calcEntryStopPrice(side) {
    if (side !== 'LONG' && side !== 'SHORT') return null;
    return calcEntryLevels(side)?.stopPrice ?? null;
  }

  function savePositionSlTpStorage(side, entryPrice, stopPrice, takeProfitPrice) {
    if (stopPrice == null && takeProfitPrice == null) return;
    try {
      sessionStorage.setItem(POS_SLTP_STORAGE_KEY, JSON.stringify({
        side,
        entryPrice,
        stopPrice,
        takeProfitPrice,
        symbol: state.symbol,
      }));
    } catch { /* ignore */ }
  }

  function loadPositionSlTpStorage() {
    try {
      const raw = sessionStorage.getItem(POS_SLTP_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function clearPositionSlTpStorage() {
    sessionStorage.removeItem(POS_SLTP_STORAGE_KEY);
  }

  function resolveOpenPositionSlTp(side, entryPrice) {
    if (!side || entryPrice == null) return null;
    const needSl = state.useStopLoss !== false;
    if ((needSl ? positionStopPrice != null : true) && positionTakeProfitPrice != null) {
      return {
        stopPrice: needSl ? positionStopPrice : null,
        takeProfitPrice: positionTakeProfitPrice,
      };
    }
    const stored = loadPositionSlTpStorage();
    if (stored
      && stored.side === side
      && stored.symbol === state.symbol
      && Math.abs(stored.entryPrice - entryPrice) < entryPrice * 0.0001) {
      return {
        stopPrice: needSl ? stored.stopPrice : null,
        takeProfitPrice: stored.takeProfitPrice,
      };
    }
    const levels = calcEntryLevels(side, entryPrice);
    return levels
      ? {
        stopPrice: needSl ? levels.stopPrice : null,
        takeProfitPrice: levels.takeProfitPrice,
      }
      : null;
  }

  function applyResolvedSlTp(side, entryPrice, resolved, { persistPaper = false } = {}) {
    if (!resolved) return;
    positionStopPrice = state.useStopLoss === false ? null : resolved.stopPrice;
    positionTakeProfitPrice = resolved.takeProfitPrice;
    savePositionSlTpStorage(side, entryPrice, positionStopPrice, positionTakeProfitPrice);
    if (persistPaper && !isTestnetMode()) {
      const pos = FuturesPaper.getPosition();
      if (pos) {
        pos.stopPrice = resolved.stopPrice;
        pos.takeProfitPrice = resolved.takeProfitPrice;
      }
    }
  }

  function getPositionEntryTimeSec() {
    if (!lastCandles.length) return null;
    if (!isTestnetMode()) {
      const openMs = FuturesPaper.getPosition()?.openTime;
      if (openMs) return Math.floor(openMs / 1000);
    }
    return lastCandles.at(-1)?.time ?? null;
  }

  function updatePositionOverlay() {
    if (!Chart.available()) return;

    let side = null;
    let entryPrice = null;
    let stopPrice = null;
    let takeProfitPrice = null;

    if (isTestnetMode() && testnetStatus?.position) {
      side = testnetStatus.position.side;
      entryPrice = testnetStatus.position.entryPrice;
      // Prefer exchange-registered trigger prices (source of truth on Binance).
      stopPrice = testnetStatus.position.stopPrice ?? positionStopPrice;
      takeProfitPrice = testnetStatus.position.takeProfitPrice ?? positionTakeProfitPrice;
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
      Chart.clearSignalOverlay();
      Chart.setPositionOverlay({
        side,
        entryPrice,
        showEntry: true,
        stopPrice,
        takeProfitPrice,
        entryTime: getPositionEntryTimeSec(),
      });
    } else {
      Chart.clearPositionOverlay();
    }
  }

  /** Keep held-position SL/TP dashed lines on the chart across ticks and reloads. */
  function ensurePositionSlTpOverlay() {
    if (!hasOpenPosition()) return;

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
    if (!side || entryPrice == null) return;

    if (positionTakeProfitPrice == null || (state.useStopLoss !== false && positionStopPrice == null)) {
      const resolved = resolveOpenPositionSlTp(side, entryPrice);
      applyResolvedSlTp(side, entryPrice, resolved, { persistPaper: !isTestnetMode() });
    }
    updatePositionOverlay();
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

    applyResolvedSlTp(side, entryPrice, {
      stopPrice: state.useStopLoss === false ? null : levels.stopPrice,
      takeProfitPrice: levels.takeProfitPrice,
    }, { persistPaper: !isTestnetMode() });
    updatePositionOverlay();
    scheduleExchangeSlTpSync();
  }

  function clearPositionStop() {
    positionStopPrice = null;
    positionTakeProfitPrice = null;
    clearPositionSlTpStorage();
    resetSlTpConfirm();
    slTpPreviewTouchedAt = 0;
    Chart.clearPositionOverlay();
    Chart.clearStopLossLine();
  }

  function formatLevelsNote(levels) {
    if (!levels) return '';
    const sl = state.useStopLoss !== false && levels.stopPrice != null
      ? ` · SL $${levels.stopPrice.toFixed(2)}`
      : '';
    return `${sl} · TP $${levels.takeProfitPrice.toFixed(2)}`;
  }

  async function getEquity() {
    const price = state.lastPrice;
    if (isTestnetMode()) {
      await refreshTestnetStatus();
      return testnetStatus?.walletBalance ?? testnetStatus?.balance ?? 0;
    }
    return FuturesPaper.getEquity(price);
  }

  async function calcTradeMarginForLevels(levels) {
    readFormSettings();
    const equity = await getEquity();
    // PnL mode sizes with a fixed margin (riskPerTrade% of equity) — the SL
    // PnL amount itself caps the loss, and the % conversion in
    // readSlTpSettings assumes exactly this margin.
    if (state.slTpMode === 'pnl') {
      return Math.max(5, Math.round(((equity * state.riskPerTradePct) / 100) * 100) / 100);
    }
    return RiskSizing.calcTradeMarginForEntry(equity, getRiskSettings(), levels);
  }

  async function calcTradeMarginForTrade() {
    readFormSettings();
    const equity = await getEquity();
    if (state.slTpMode === 'pnl') {
      return Math.max(5, Math.round(((equity * state.riskPerTradePct) / 100) * 100) / 100);
    }
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
    if (!Chart.available()) return;
    const cs = Chart.getState() || {};
    state.interval = cs.interval || state.interval;
    state.lastPrice = Chart.getPrice() || state.lastPrice;
    lastCandles = Chart.getCandles() || lastCandles;
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
    readSlTpSettings();
    state.pollSeconds = parseInt($('#pollSeconds').value, 10) || 60;
    state.backtestTradeCount = clampBacktestTradeCount($('#backtestTradeCount')?.value);
    syncFromChart();
  }

  // SL/TP can be entered two ways; everything downstream (strategy, preview,
  // backtest, risk sizing, server bot export) consumes stopLossPct/takeProfitPct,
  // so each mode is normalized to a % distance from the entry price here.
  //  - pct:   direct % fields
  //  - pnl:   USDT amounts converted via the planned position notional
  function readSlTpSettings() {
    state.slTpMode = getSlTpMode();
    state.useStopLoss = true;
    const pctSl = parseFloat($('#stopLoss')?.value) || 1.5;
    const pctTp = parseFloat($('#takeProfit')?.value) || 3;
    state.stopLossPct = pctSl;
    state.takeProfitPct = pctTp;

    if (state.slTpMode === 'pnl') {
      const slPnl = parseFloat($('#stopLossPnl')?.value);
      const tpPnl = parseFloat($('#takeProfitPnl')?.value);
      const notional = estimatePlannedNotional();
      if (notional > 0) {
        if (Number.isFinite(slPnl) && slPnl > 0) {
          state.stopLossPct = Math.min(50, Math.max(0.05, (slPnl / notional) * 100));
        }
        if (Number.isFinite(tpPnl) && tpPnl > 0) {
          state.takeProfitPct = Math.min(100, Math.max(0.05, (tpPnl / notional) * 100));
        }
      }
    }
  }

  // Equity from cached status (no network) — good enough for previews.
  function estimateEquitySync() {
    if (isTestnetMode()) {
      return testnetStatus?.walletBalance ?? testnetStatus?.balance ?? 0;
    }
    return FuturesPaper.getEquity(state.lastPrice);
  }

  // Position value the next trade will open with. In PnL mode the risk-based
  // margin formula would be circular (margin depends on SL% which depends on
  // margin), so the margin is fixed at riskPerTrade% of equity — the actual
  // loss cap is the SL PnL amount itself.
  function estimatePlannedNotional() {
    const equity = estimateEquitySync();
    if (!(equity > 0)) return 0;
    const margin = Math.max(5, (equity * state.riskPerTradePct) / 100);
    return margin * state.leverage;
  }

  function clampBacktestTradeCount(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return BACKTEST_TRADES_DEFAULT;
    return Math.min(BACKTEST_TRADES_MAX, Math.max(BACKTEST_TRADES_MIN, n));
  }

  async function refreshTestnetStatus() {
    if (!isTestnetMode()) return null;
    const hadPosition = Boolean(testnetStatus?.position);
    testnetStatus = await FuturesApiClient.getStatus();
    // Adopt exchange-registered SL/TP trigger prices as the source of truth.
    const pos = testnetStatus?.position;
    if (pos) {
      if (pos.stopPrice != null) positionStopPrice = pos.stopPrice;
      if (pos.takeProfitPrice != null) positionTakeProfitPrice = pos.takeProfitPrice;
    } else if (hadPosition) {
      // Position disappeared — closed by SL/TP, liquidation, or a manual close
      // outside this browser (e.g. exchange website). Whatever the cause, a
      // still-active entry signal must not silently reopen the trade: drop the
      // SL/TP confirmation and pause auto entry until the current bar closes.
      if (slTpConfirmed) {
        addLog('포지션 종료 감지 — 전략 SL/TP로 재진입 대기', 'info');
      }
      autoConfirmSlTpFromStrategy();
      slTpPreviewTouchedAt = 0;
    }
    return testnetStatus;
  }

  function buildManualCloseBlock(closedSide) {
    const secondsMap = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
    const intervalSec = secondsMap[state.interval] || 60;
    const barTime = lastCandles.at(-1)?.time ?? Math.floor(Date.now() / 1000);
    const barEndMs = (barTime + intervalSec) * 1000;
    const until = Math.max(Date.now() + 30_000, Math.min(barEndMs, Date.now() + 15 * 60_000));
    return { barTime, signal: closedSide, until };
  }

  function isManualCloseBlocked(result) {
    return EntryPause.isBlocked(result?.signal, lastCandles.at(-1)?.time);
  }

  function stripServerLogLine(line) {
    return line.replace(/^\S+\s+\[(INFO|WARN|ERROR|DEBUG)\]\s*/, '');
  }

  const SERVER_BOT_LOG_RE = /SIGNAL |OPEN |진입|Entry |skipped|최소 주문|증거금|Quantity |Margin |리스크 계획|SL\/TP/;

  function forwardServerBotLogs(logs) {
    if (!Array.isArray(logs)) return;
    for (const line of logs) {
      if (!line || seenServerBotLogs.has(line)) continue;
      seenServerBotLogs.add(line);
      if (seenServerBotLogs.size > 120) {
        const drop = [...seenServerBotLogs].slice(0, 40);
        drop.forEach((k) => seenServerBotLogs.delete(k));
      }
      if (!SERVER_BOT_LOG_RE.test(line)) continue;
      const msg = stripServerLogLine(line);
      const level = /\[ERROR\]/.test(line) ? 'loss' : (/\[WARN\]/.test(line) ? 'warn' : 'info');
      addLog(`[서버 봇] ${msg}`, level);
      lastServerBotLogLine = line;
    }
  }
  function logManualCloseBlockOnce(result) {
    const block = EntryPause.getBlock();
    const key = `manual:${block?.barTime}:${block?.signal}`;
    const sig = result?.signal || block?.signal || '';
    logEntrySkipOnce(key, `${sig} — 수동 청산 직후 같은 봉 재진입을 보류합니다.`);
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
          if (st) {
            serverBotLive = st.liveTrading !== false && !st.dryRun;
            serverEntryGate = st.entryGate || null;
            if (st.dryRun && !serverBotDryWarned) {
              serverBotDryWarned = true;
              addLog(
                '서버 봇이 DRY_RUN 모드입니다 — 신호만 잡히고 실제 테스트넷 주문은 없습니다. 봇을 정지한 뒤 다시 시작하면 실거래 모드로 실행됩니다.',
                'warn',
              );
            }
            const logs = st.recentLogs;
            forwardServerBotLogs(logs);
          }
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

  // 서버 봇이 이미 돌고 있을 때 SL/TP·진입 조건이 바뀌면 strategy.json을
  // 다시 올린다 (봇은 파일 변경을 감지해 다음 체크부터 새 설정 적용).
  // 예전에는 봇 시작 시 한 번만 보내서, 실행 중 GPT/수동 변경이 서버 봇에
  // 영영 반영되지 않았다.
  let serverStrategySyncTimer = null;
  function scheduleServerStrategySync() {
    if (!isTestnetMode() || !serverBotActive) return;
    clearTimeout(serverStrategySyncTimer);
    serverStrategySyncTimer = setTimeout(async () => {
      try {
        await syncStrategyToServer();
        addLog('변경된 전략을 실행 중인 서버 봇에 반영했습니다 (다음 체크부터 적용).', 'info');
      } catch (err) {
        addLog(`서버 봇 전략 반영 실패: ${err.message} — 봇을 재시작하면 적용됩니다.`, 'loss');
      }
    }, 1200);
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
      serverBotLive = health.bot.liveTrading !== false && !health.bot.dryRun;
      botRunning = true;
      $('#startBotBtn').disabled = true;
      $('#stopBotBtn').disabled = false;
      const mode = serverBotLive ? '테스트넷 실거래' : 'DRY_RUN 시뮬레이션';
      addLog(`서버 봇 실행 중 (${mode}) — 브라우저를 닫아도 24/7 계속`, 'info');
      if (!serverBotLive) serverBotDryWarned = true;
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
    if (!Chart.available()) return;
    const show = $('#showSwingOnChart')?.checked ?? false;
    if (!show || !candles?.length) {
      Chart.clearSwingLevels();
      return;
    }
    readFormSettings();
    const levels = SwingLevels.calcFromCandles(candles, {
      swingPivotBars: state.swingPivotBars,
      swingLookback: state.swingLookback,
    });
    Chart.setSwingLevels({
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
    const settings = getSettings();
    // Merge every enabled slot's conditions so indicator detection (chart
    // buttons, MACD/RSI filters) covers all active entry conditions.
    if (StrategyEngine?.normalizeSlots && StrategyEngine?.mergedSlotRules) {
      return StrategyEngine.mergedSlotRules(StrategyEngine.normalizeSlots(settings));
    }
    return StrategyEngine?.normalizeRules?.(settings) || null;
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
    if (!Chart.available()) return;
    readFormSettings();

    Chart.toggleIndicator('rsi', chartIndicators.rsi);
    Chart.toggleIndicator('macd', chartIndicators.macd);

    if (chartIndicators.ema) {
      Chart.setIndicatorParams('ema7', { period: state.emaFast, color: '#ffeb3b' });
      Chart.setIndicatorParams('ema25', { period: state.emaSlow, color: '#00bcd4' });
      Chart.toggleIndicator('ema7', true);
      Chart.toggleIndicator('ema25', true);
    } else {
      Chart.toggleIndicator('ema7', false);
      Chart.toggleIndicator('ema25', false);
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
    // 1년 넘게 걸치는 결과에서 연도가 없으면 "10월 11일 ~ 10월 8일"처럼
    // 거꾸로 보이는 착시가 생긴다 — 연도를 반드시 포함한다.
    const fmt = (t) => new Date(t * 1000).toLocaleString('ko-KR', {
      year: '2-digit',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const market = window.KlineLoader?.getMarket?.() === 'futures' ? '선물' : '현물';
    return `${bars}봉 · ${market} · ${fmt(stats.rangeFromTime)} ~ ${fmt(stats.rangeToTime)}`;
  }

  function formatBacktestStats(stats, interval) {
    const pnlCls = stats.totalPnlPct >= 0 ? 'positive' : 'negative';
    const pnlSign = stats.totalPnlPct >= 0 ? '+' : '';
    const intervalLabel = INTERVALS[interval]?.label || interval || '—';
    let countLabel = stats.targetTrades
      ? `${stats.trades}/${stats.targetTrades}회`
      : `${stats.trades}회`;
    if (stats.targetTrades && !stats.targetReached) {
      if (stats.historyExhausted) {
        countLabel += ` · 선물 히스토리 끝 (${stats.candlesUsed.toLocaleString()}봉)`;
      } else {
        countLabel += ` · 전체 히스토리 ${stats.candlesUsed.toLocaleString()}봉`;
      }
    }
    if (stats.chartVisibleTrades != null && stats.chartVisibleTrades < stats.trades) {
      countLabel += ` (차트 최신 ${stats.chartVisibleTrades}/${stats.trades}회 — 과거는 왼쪽 스크롤)`;
    }
    return (
      `백테스트 ${countLabel} (${intervalLabel} ${formatBacktestRange(stats)}) | 승률 ${stats.winRate.toFixed(0)}% ` +
      `(${stats.wins}W ${stats.losses}L) | ` +
      `<span class="${pnlCls}">누적 ${pnlSign}${stats.totalPnlPct.toFixed(2)}%</span>`
    );
  }

  // In PnL mode stopLossPct/takeProfitPct are DERIVED from the live
  // price or equity and drift a little every tick. Keying the cache on them
  // would treat every tick as a "settings change", cancel the in-flight
  // history load, and the backtest would never finish — so the key uses the
  // raw user inputs instead of the derived values.
  function backtestSettingsForKey(settings) {
    let keyed = settings;
    // Slot names are cosmetic — exclude them so renaming a condition does not
    // needlessly invalidate the backtest cache.
    if (Array.isArray(settings.strategySlots)) {
      keyed = {
        ...settings,
        entryRules: undefined,
        strategySlots: settings.strategySlots.map((s) => ({
          enabled: s.enabled !== false,
          entryRules: s.entryRules,
          exitRules: s.exitRules,
        })),
      };
    }
    if (state.slTpMode === 'pnl') {
      return {
        ...keyed,
        stopLossPct: `pnl:${$('#stopLossPnl')?.value ?? ''}`,
        takeProfitPct: `pnl:${$('#takeProfitPnl')?.value ?? ''}`,
      };
    }
    return {
      ...keyed,
      useStopLoss: state.useStopLoss !== false,
    };
  }

  function backtestCacheKey(interval, targetTrades, settings) {
    return `${state.symbol}:${interval}:${targetTrades}:${JSON.stringify(backtestSettingsForKey(settings))}`;
  }

  function getBacktestCacheKey(settings = getSettings()) {
    const interval = Chart.getState()?.interval || state.interval;
    readFormSettings();
    return backtestCacheKey(interval, state.backtestTradeCount, settings);
  }

  function clearBacktestChartDisplay(chartCandles) {
    if (!Chart.available()) return;
    const candles = chartCandles?.length ? chartCandles : (Chart.getCandles() || lastCandles);
    Chart.setMarkers(getSwingPivotMarkers(candles));
    clearBacktestOverlays();
  }

  function invalidateBacktestChart(chartCandles, { message = null } = {}) {
    backtestHistoryExpandId += 1;
    BacktestRunner.invalidate({ message });
    if (showBacktest) clearBacktestChartDisplay(chartCandles);
  }

  function filterTradesToChart(trades, chartCandles) {
    if (!chartCandles?.length || !trades?.length) return [];
    const minTime = chartCandles[0].time;
    const maxTime = chartCandles.at(-1).time;
    return trades.filter((t) => t.exitTime >= minTime && t.entryTime <= maxTime);
  }

  function syncBacktestOverlays(trades, chartCandles) {
    Chart.setBacktestTradeOverlays(trades, chartCandles);
  }

  function focusBacktestTrades(trades) {
    if (!trades?.length || !Chart.available()) return;
    const chartCandles = Chart.getCandles() || lastCandles;
    if (!chartCandles.length) return;
    Chart.pinBacktestChartView?.(true);
    const newestCount = Math.min(8, trades.length);
    const focusPool = trades.slice(-newestCount);
    const fromT = Math.min(...focusPool.map((t) => t.entryTime));
    const toT = Math.max(...focusPool.map((t) => t.exitTime));
    const applyFocus = () => {
      Chart.focusChartTimeRange(fromT, toT, 12, { anchor: 'end' });
    };
    applyFocus();
    requestAnimationFrame(() => requestAnimationFrame(applyFocus));
  }

  const BAR_SECONDS = {
    '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
    '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800,
    '12h': 43200, '1d': 86400,
  };

  async function expandChartHistoryForTrades(trades, onDone) {
    if (!trades?.length || !Chart.available()) {
      onDone?.();
      return;
    }
    const runId = ++backtestHistoryExpandId;
    const earliestEntry = Math.min(...trades.map((t) => t.entryTime));
    const chartData = Chart.getCandles() || [];
    if (!chartData.length || earliestEntry >= chartData[0].time) {
      onDone?.();
      return;
    }
    const interval = Chart.getState()?.interval || state.interval;
    const barSec = BAR_SECONDS[interval] || 3600;
    const needBars = Math.ceil((chartData[0].time - earliestEntry) / barSec);
    const maxPages = Math.min(70, Math.ceil(needBars / 1000) + 3);
    try {
      await Chart.loadHistoryUntilTime(earliestEntry, maxPages, { relaxBarCap: true });
    } catch (err) {
      console.warn('[백테스트] 과거 차트 확장 실패:', err);
    }
    if (runId !== backtestHistoryExpandId) return;
    onDone?.();
  }

  function applyBacktestMarkersToChart(markers, trades, chartCandles) {
    const scoped = filterMarkersToChart(markers, chartCandles);
    Chart.setMarkers(mergeChartMarkers(scoped, chartCandles));
    syncBacktestOverlays(filterTradesToChart(trades, chartCandles), chartCandles);
  }

  function clearBacktestOverlays() {
    Chart.clearBacktestTradeOverlays();
  }

  function filterMarkersToChart(markers, chartCandles) {
    if (!chartCandles?.length || !markers?.length) return markers || [];
    const minTime = chartCandles[0].time;
    const maxTime = chartCandles.at(-1).time;
    return markers.filter((m) => m.time >= minTime && m.time <= maxTime);
  }

  function renderBacktestResult(result, { force = false, focusChart = false } = {}) {
    const statsEl = $('#backtestStats');
    const { interval, stats, trades, markers, displayCandles } = result;
    const chartCandles = Chart.getCandles()?.length
      ? Chart.getCandles()
      : (displayCandles?.length ? displayCandles : lastCandles);
    const visibleTrades = filterTradesToChart(trades, chartCandles);
    const reportStats = { ...stats, chartVisibleTrades: visibleTrades.length };
    const shouldFocus = showBacktest && trades.length && (focusChart || force);

    if (showBacktest || force) {
      clearBacktestOverlays();
      if (shouldFocus) focusBacktestTrades(trades);
      applyBacktestMarkersToChart(markers, trades, chartCandles);
      const hiddenTrades = trades.length - visibleTrades.length;
      if (hiddenTrades > 0) {
        expandChartHistoryForTrades(trades, () => {
          const updated = Chart.getCandles() || chartCandles;
          applyBacktestMarkersToChart(markers, trades, updated);
          if (shouldFocus) focusBacktestTrades(trades);
          const statsElRefresh = $('#backtestStats');
          if (statsElRefresh && statsElRefresh.innerHTML) {
            const refreshedVisible = filterTradesToChart(trades, updated);
            const refreshedStats = { ...reportStats, chartVisibleTrades: refreshedVisible.length };
            statsElRefresh.innerHTML = formatBacktestStats(refreshedStats, interval);
          }
        });
      }
    } else {
      Chart.pinBacktestChartView?.(false);
      Chart.setMarkers(getSwingPivotMarkers(chartCandles));
      clearBacktestOverlays();
    }
    if (statsEl) statsEl.innerHTML = formatBacktestStats(reportStats, interval);
  }

  async function handleBacktestCompute(chartCandles, { force = false, focusChart = false } = {}) {
    const statsEl = $('#backtestStats');
    if (!Chart.available()) {
      if (statsEl) statsEl.textContent = '백테스트: — (차트 미연동)';
      return;
    }

    try {
      updateSwingChartOverlay(chartCandles);
      const result = await BacktestRunner.compute(chartCandles, { force, focusChart });
      if (result.skipped) {
        if (force && statsEl && !statsEl.innerHTML.includes('로딩 중')) {
          statsEl.textContent = '백테스트: 계산 진행 중...';
        }
        return;
      }
      if (result.cancelled) return;
      if (!result.ok) {
        if (result.reason && !result.error) {
          Chart.setMarkers(getSwingPivotMarkers(chartCandles));
          clearBacktestOverlays();
          if (statsEl) statsEl.textContent = `백테스트: — (${result.reason})`;
        } else if (result.error && statsEl) {
          statsEl.textContent = `백테스트 실패: ${result.error.message}`;
        }
        return;
      }
      renderBacktestResult(result, { force, focusChart });
    } catch (err) {
      console.error('[백테스트] 표시 오류 (봇/차트는 계속 실행):', err);
      if (statsEl) statsEl.textContent = `백테스트 표시 실패: ${err.message}`;
    }
  }

  function applyBacktest(chartCandles, options = {}) {
    const focusChart = options.focusChart ?? Boolean(options.force);
    handleBacktestCompute(chartCandles, { ...options, focusChart }).catch((err) => {
      console.error('[백테스트] 비동기 오류 (봇/차트는 계속 실행):', err);
    });
  }

  function scheduleBacktest(chartCandles) {
    if (!showBacktest && !BacktestRunner.isLoading()) return;
    BacktestRunner.scheduleRefresh(chartCandles);
  }

  async function runBacktest() {
    const statsEl = $('#backtestStats');
    const btn = $('#runBacktestBtn');
    if (btn) btn.disabled = true;

    try {
      if (!Chart.available()) {
        if (statsEl) statsEl.textContent = '백테스트: — (차트 미연동)';
        return;
      }

      syncFromChart();
      let chartCandles = Chart.getCandles() || lastCandles;

      if (!chartCandles.length) {
        if (statsEl) statsEl.textContent = '백테스트: 차트 데이터 로딩 중...';
        await Chart.reloadChart();
        syncFromChart();
        chartCandles = Chart.getCandles() || lastCandles;
      }

      lastCandles = chartCandles;
      await BacktestRunner.runExplicit(chartCandles);
    } catch (err) {
      console.error('[백테스트] 실행 오류 (봇/차트는 계속 실행):', err);
      if (statsEl) statsEl.textContent = `백테스트 실패: ${err.message}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function configureBacktestRunner() {
    BacktestRunner.configure({
      readFormSettings,
      getSettings,
      getSymbol: () => state.symbol,
      getInterval: () => Chart.getState()?.interval || state.interval,
      getTargetTrades: () => state.backtestTradeCount,
      getShowBacktest: () => showBacktest,
      getCacheKey: () => getBacktestCacheKey(),
      getChartCandles: () => Chart.getCandles() || lastCandles,
      cacheKey: backtestCacheKey,
      loadChartHistoryUntil: (time, maxPages, opts) => Chart.loadHistoryUntilTime(time, maxPages, opts),
      onProgress: (p) => {
        const statsEl = $('#backtestStats');
        if (!statsEl) return;
        if (p.phase === 'compute') {
          statsEl.textContent =
            `백테스트: 계산 중... (${p.trades}/${p.target}회, ${(p.candles ?? 0).toLocaleString()}봉)`;
          return;
        }
        const pageInfo = p.page != null ? ` · ${p.page}/${p.maxPages}페이지` : '';
        const suffix = p.exhausted ? ' · 히스토리 끝' : '';
        statsEl.textContent =
          `백테스트: 과거 데이터 로딩 중... (${p.trades}/${p.target}회, ` +
          `${(p.candles ?? 0).toLocaleString()}봉${pageInfo})${suffix}`;
      },
      onInvalidate: (message) => {
        const statsEl = $('#backtestStats');
        if (message && statsEl) statsEl.textContent = message;
      },
      onCompute: (candles, opts) => handleBacktestCompute(candles, opts),
    });
  }

  function onChartCandlesUpdated(e) {
    lastCandles = e.detail?.candles || Chart.getCandles() || [];
    state.interval = e.detail?.interval || Chart.getState()?.interval || state.interval;
    state.lastPrice = lastCandles.at(-1)?.close || Chart.getPrice() || 0;
    scheduleBacktest(lastCandles);
    updateSignalDisplay();
    ensurePositionSlTpOverlay();
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
    if (result?.signal === 'LONG' || result?.signal === 'SHORT') {
      lastPendingSide = result.signal;
    }
    syncPreviewSlTpOverlay(result);
    if (hasOpenPosition()) ensurePositionSlTpOverlay();
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
      const secs = 3;
      if (serverEntryGate?.active) {
        const reason = serverEntryGate.reason === 'manual_close'
          ? '수동 청산 후 재진입 보류'
          : '진입 일시정지';
        logEntrySkipOnce(`gate:${key}`, `${result.signal} 신호 — 서버 ${reason} (게이트 활성)`);
        return;
      }
      const mode = serverBotLive
        ? `${result.signal} 신호 — 서버 봇이 ${secs}초마다 진입 확인 중`
        : `${result.signal} 신호 — DRY_RUN(시뮬레이션). 봇 정지 후 다시 시작하세요`;
      logEntrySkipOnce(`server:${key}`, mode);
      return;
    }
    if (autoEntryBusy || liveExitBusy) return;
    if (Date.now() < autoEntryRetryAt) return;
    if (isManualCloseBlocked(result)) {
      logManualCloseBlockOnce(result);
      return;
    }
    if (isAutoEntryPaused()) {
      logEntrySkipOnce(`pause:${key}`, `${result.signal} 신호 — 수동 청산 직후 대기 중이라 진입을 보류합니다.`);
      return;
    }
    if (hasOpenPosition()) return;
    if (!slTpConfirmed && !autoConfirmSlTpFromStrategy()) {
      logEntrySkipOnce(`sltp:${key}`, `${result.signal} 신호 — AI 전략에 SL/TP가 필요합니다.`);
      return;
    }
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

  // Preview entry/SL/TP on chart (left labels + dashed lines). Cleared when no preview.
  function syncSignalOverlay(result) {
    syncPreviewSlTpOverlay(result);
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
    const previewSide = lastPendingSide || 'LONG';
    const previewPrice = state.lastPrice || lastCandles.at(-1)?.close;
    const previewLevels = previewPrice ? calcEntryLevels(previewSide, previewPrice) : null;
    const riskSettings = getRiskSettings();
    const plan = previewLevels
      ? RiskSizing.summarizeRiskPlan(equity, riskSettings, previewLevels)
      : null;
    const marginPreview = plan?.margin ?? RiskSizing.calcTradeMargin(equity, riskSettings);
    const slPct = plan?.stopLossPct ?? state.stopLossPct;
    const lossAtSl = plan?.lossAtSl ?? RiskSizing.estimateLossAtSl(marginPreview, state.leverage, slPct);
    const targetLoss = plan?.targetLoss ?? RiskSizing.targetLossUsdt(equity, state.riskPerTradePct);
    const lossPctOfEquity = equity > 0 ? (lossAtSl / equity) * 100 : 0;

    $('#notionalInfo').innerHTML =
      `증거금 $${marginPreview.toFixed(0)} (${state.leverage}x) · ` +
      `<span class="text-muted">SL ${slPct != null ? slPct.toFixed(2) : '—'}% · 손절 시 -$${lossAtSl.toFixed(2)} (목표 -$${targetLoss.toFixed(2)}, ${lossPctOfEquity.toFixed(2)}%)</span>`;

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
        if (positionStopPrice != null || positionTakeProfitPrice != null) clearPositionStop();
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
      updateConfirmSlTpUi();
      return;
    }

    const pos = FuturesPaper.getPosition();
    if (!pos) {
      posEl.innerHTML = '<span class="text-muted">포지션 없음</span>';
      $('#positionPnl').textContent = '';
      // Clear once on the open→closed transition only; calling this every
      // refresh while flat would wipe the SL/TP confirm + preview state.
      if (positionStopPrice != null || positionTakeProfitPrice != null) clearPositionStop();
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
    updateConfirmSlTpUi();
    updateSlTpStrategyHint();
  }

  async function executeSignal(result) {
    const price = state.lastPrice;
    // Loss-limit gate applies to NEW entries only — CLOSE must always go
    // through, otherwise a position could never exit once the limit is hit.
    if ((result.signal === 'LONG' || result.signal === 'SHORT')
      && await checkAccountLossLimit()) return;

    if (isTestnetMode()) {
      const pos = testnetStatus?.position;

      if (result.signal === 'CLOSE' && pos) {
        try {
          await FuturesApiClient.closePosition({ manual: false });
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
        if (!requireSlTpConfirmedForEntry()) return;
        await refreshTestnetStatus();
        if (testnetStatus?.position) {
          addLog(`${result.signal} 신호 — 이미 ${testnetStatus.position.side} 포지션 보유 중이라 진입 생략`, 'info');
          return;
        }
        try {
          readFormSettings();
          const side = result.signal;
          const levels = calcEntryLevels(side) || result.entryLevels;
          if (!levels) {
            addLog('진입 실패: 손절/익절 계산 불가', 'loss');
            return;
          }
          const tradeMargin = await calcTradeMarginForLevels(levels);
          await FuturesApiClient.setup({
            leverage: state.leverage,
            marginType: 'ISOLATED',
            symbol: state.symbol,
            tradeMarginUsdt: tradeMargin,
          });
          const r = await FuturesApiClient.openPosition(side, tradeMargin, state.leverage, price, levels);
          positionStopPrice = r.stopPrice ?? levels.stopPrice;
          positionTakeProfitPrice = r.takeProfitPrice ?? levels.takeProfitPrice;
          savePositionSlTpStorage(side, price, positionStopPrice, positionTakeProfitPrice);
          addLog(`${side} 진입 ${r.quantity?.toFixed(6) || ''} BTC @ $${price.toFixed(2)}${formatLevelsNote(levels)}`, side === 'LONG' ? 'win' : 'loss');
          if (r.stopPrice != null || r.takeProfitPrice != null) {
            addLog('거래소에 SL/TP 주문 등록 완료 — 브라우저를 닫아도 체결됩니다.', 'info');
          }
          updatePositionStopLine();
          await refreshTestnetStatus();
          updateUI();
        } catch (err) {
          await handleEntryError(err, result.signal);
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
      if (!requireSlTpConfirmedForEntry()) return;
      const side = result.signal;
      const levels = calcEntryLevels(side) || result.entryLevels;
      if (!levels) {
        addLog('진입 실패: 손절/익절 계산 불가', 'loss');
        return;
      }
      const tradeMargin = await calcTradeMarginForLevels(levels);
      const r = FuturesPaper.openPosition(
        side,
        price,
        tradeMargin,
        state.leverage,
        levels.stopPrice,
        levels.takeProfitPrice,
      );
      if (r.ok) {
        positionStopPrice = levels.stopPrice;
        positionTakeProfitPrice = levels.takeProfitPrice;
        savePositionSlTpStorage(side, price, levels.stopPrice, levels.takeProfitPrice);
        updatePositionStopLine();
      }
      addLog(r.message + (r.ok ? formatLevelsNote(levels) : ''), r.ok ? (side === 'LONG' ? 'win' : 'loss') : 'loss');
    }
  }

  // Live SL/TP check that runs on every price tick (not just the poll
  // interval). Runs whenever a position is open — even with the bot stopped —
  // so manual entries and post-stop positions still get their SL/TP filled.
  // Only skipped when the 24/7 server bot owns the position.
  async function evaluateLiveExit() {
    if (liveExitBusy) return;
    if (isTestnetMode() && serverBotActive) return;
    if (!hasOpenPosition()) return;
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
        stopPrice: state.useStopLoss === false ? null : positionStopPrice,
        takeProfitPrice: positionTakeProfitPrice,
        stopLossPct: settings.stopLossPct,
        takeProfitPct: settings.takeProfitPct,
        useStopLoss: settings.useStopLoss,
      };
    } else {
      const pos = FuturesPaper.getPosition();
      if (!pos) return;
      posSide = pos.side;
      entryPrice = pos.entryPrice;
      extras = {
        stopPrice: settings.useStopLoss === false ? null : pos.stopPrice,
        takeProfitPrice: pos.takeProfitPrice,
        stopLossPct: pos.stopLossPct ?? settings.stopLossPct,
        takeProfitPct: pos.takeProfitPct ?? settings.takeProfitPct,
        useStopLoss: settings.useStopLoss,
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
        stopPrice = currentPos
          ? (settings.useStopLoss === false ? null : positionStopPrice)
          : null;
        takeProfitPrice = currentPos ? positionTakeProfitPrice : null;
      } else {
        currentPos = FuturesPaper.getPosition();
        posSide = currentPos?.side || null;
        entryPrice = currentPos?.entryPrice || null;
        stopPrice = settings.useStopLoss === false ? null : (currentPos?.stopPrice ?? null);
        takeProfitPrice = currentPos?.takeProfitPrice ?? null;
      }

      if (posSide && entryPrice && !liveExitBusy) {
        const exit = FuturesStrategy.checkExit(posSide, entryPrice, price, settings, {
          stopPrice,
          takeProfitPrice,
          stopLossPct: currentPos?.stopLossPct ?? settings.stopLossPct,
          takeProfitPct: currentPos?.takeProfitPct ?? settings.takeProfitPct,
          useStopLoss: settings.useStopLoss,
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
        if (isManualCloseBlocked(result)) {
          logManualCloseBlockOnce(result);
        } else if (isAutoEntryPaused()) {
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

  async function applyChartInterval(interval) {
    if (!interval || !INTERVALS[interval]) return false;
    if ((Chart.getState()?.interval || state.interval) === interval) {
      state.interval = interval;
      setBotIntervalSelection(interval);
      return true;
    }
    addLog(`AI 봉 주기 ${INTERVALS[interval].label} — 차트 전환 중...`, 'info');
    const ok = await Chart.setInterval(interval);
    if (!ok) {
      addLog(`${INTERVALS[interval].label} 차트 전환 실패`, 'warn');
      return false;
    }
    syncFromChart();
    state.interval = interval;
    setBotIntervalSelection(interval);
    return true;
  }

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

    const chartInterval = Chart.getState()?.interval;
    if (chartInterval !== sel) {
      addLog(`봇 봉 주기 ${INTERVALS[sel].label} — 차트를 전환하는 중...`, 'info');
      const ok = await Chart.setInterval(sel);
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
        await FuturesApiClient.clearBotEntryPause();
        seenServerBotLogs.clear();
        await FuturesApiClient.startServerBot({ liveTrading: true });
        serverBotActive = true;
        serverBotLive = true;
        serverBotDryWarned = false;
        botRunning = true;
        $('#startBotBtn').disabled = true;
        $('#stopBotBtn').disabled = false;
        startStatusPolling();
        addLog(
          `서버 봇 시작 (테스트넷 실거래) — BTC ${INTERVALS[state.interval]?.label || state.interval}, ${state.leverage}x`,
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

    readFormSettings();
    const preview = FuturesStrategy.analyze(lastCandles, getSettings(), null);
    if (isManualCloseBlocked(preview)) {
      logManualCloseBlockOnce(preview);
      return;
    }
    if (isAutoEntryPaused()) {
      addLog('수동 청산 직후 대기 중 — 잠시 후 다시 시도하세요.', 'info');
      return;
    }

    const price = state.lastPrice;
    if (!price) {
      addLog('가격 정보가 없습니다.', 'loss');
      return;
    }

    if (!requireSlTpConfirmedForEntry()) return;

    readFormSettings();
    const levels = calcEntryLevels(side);
    if (!levels) {
      addLog('진입 실패: 손절/익절 계산 불가', 'loss');
      return;
    }
    const tradeMargin = await calcTradeMarginForLevels(levels);

    try {
      await FuturesApiClient.setup({
        leverage: state.leverage,
        marginType: 'ISOLATED',
        symbol: state.symbol,
        tradeMarginUsdt: tradeMargin,
      });
      const r = await FuturesApiClient.openPosition(side, tradeMargin, state.leverage, price, levels);
      positionStopPrice = r.stopPrice ?? levels.stopPrice;
      positionTakeProfitPrice = r.takeProfitPrice ?? levels.takeProfitPrice;
      savePositionSlTpStorage(side, price, positionStopPrice, positionTakeProfitPrice);
      addLog(`${side} 수동 진입 ${r.quantity?.toFixed(6) || ''} BTC @ $${price.toFixed(2)}${formatLevelsNote(levels)}`, side === 'LONG' ? 'win' : 'loss');
      if (r.stopPrice != null || r.takeProfitPrice != null) {
        addLog('거래소에 SL/TP 주문 등록 완료 — 브라우저를 닫아도 체결됩니다.', 'info');
      }
      ensurePositionSlTpOverlay();
      await refreshTestnetStatus();
      updateUI();
    } catch (err) {
      await handleEntryError(err, `${side} 수동`);
    }
  }

  // A close (manual or exchange-side) must not be instantly reversed by the
  // running bot: pause auto entries until the current bar closes (min 30s).
  function pauseAutoEntryAfterManualClose(reason = '수동 청산', closedSide = null) {
    const side = closedSide || testnetStatus?.position?.side || lastPendingSide || null;
    if (side) {
      EntryPause.blockManualClose(buildManualCloseBlock(side));
    } else {
      const secondsMap = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
      const intervalSec = secondsMap[state.interval] || 60;
      const nowSec = Math.floor(Date.now() / 1000);
      const barEndSec = lastCandles.at(-1) ? lastCandles.at(-1).time + intervalSec : nowSec + 60;
      const pausedUntil = Math.min(barEndSec * 1000, Date.now() + 15 * 60_000);
      EntryPause.pauseUntil(Math.max(Date.now() + 30_000, pausedUntil));
    }
    addLog(`${reason} — 같은 신호로 바로 재진입하지 않도록 자동 진입을 잠시 멈춥니다.`, 'info');
  }

  function isAutoEntryPaused() {
    return EntryPause.isPaused();
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
          const barTime = lastCandles.at(-1)?.time ?? null;
          if (side) EntryPause.blockManualClose(buildManualCloseBlock(side));
          resetSlTpConfirm();
          await FuturesApiClient.closePosition({
            manual: true,
            barTime,
            blockedSignal: side || null,
          });
          clearPositionStop();
          pauseAutoEntryAfterManualClose('수동 청산', side);
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
      const closedSide = FuturesPaper.getPosition()?.side || null;
      const r = FuturesPaper.closePosition(price, '수동 청산');
      if (r.ok) {
        clearPositionStop();
        pauseAutoEntryAfterManualClose('수동 청산', closedSide);
        resetSlTpConfirm();
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
    lastCandles = e.detail?.candles || Chart.getCandles() || [];
    state.interval = e.detail?.interval || Chart.getState()?.interval || state.interval;
    state.lastPrice = lastCandles.at(-1)?.close || Chart.getPrice() || 0;
    updateSignalDisplay();
    if (hasOpenPosition()) {
      ensurePositionSlTpOverlay();
      evaluateLiveExit();
    }
    if (e.detail?.newBar) {
      scheduleBacktest(lastCandles);
      updateUI();
    }
  }

  function bindUiEvents() {
    document.addEventListener('chart-candles-updated', onChartCandlesUpdated);
    document.addEventListener('chart-candle-tick', onChartCandleTick);

    const riskSlider = $('#riskPerTrade');
    if (riskSlider) {
      riskSlider.addEventListener('input', syncRiskPerTradeLabel);
      syncRiskPerTradeLabel();
    }

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
      if (!showBacktest) Chart.pinBacktestChartView?.(false);
      applyBacktest(lastCandles, { force: true, focusChart: showBacktest });
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
    configureBacktestRunner();
    bindUiEvents();

    readFormSettings();
    const stored = loadStrategyStorage();
    state.entryRules = stored.entryRules;
    state.exitRules = stored.exitRules;
    if (state.entryRules || state.exitRules) saveStrategyStorage(state.entryRules, state.exitRules);
    migrateLegacyRulesToSlots();
    renderStrategySlotsPanel();
    updateStrategyAiSlotOptions();
    $('#addStrategySlotBtn')?.addEventListener('click', () => {
      const slot = addStrategySlot();
      if (slot) {
        addLog(`진입 조건 [${slot.name}] 추가됨 — GPT에게 전략을 설명해 저장하세요.`, 'info');
        onStrategySlotsChanged({ recompute: false });
      }
    });
    updateStrategyRulesDisplay();
    updateChartIndicatorButtons();
    updateMacdLineFilterUi();
    updateRsiEntryFilterUi();
    updateSwingLevelsUi();
    sessionStartEquity = await getEquity();

    await restoreSessionFromServer();
    setModeBadge();

    if ((Chart.getCandles() || []).length) {
      onChartCandlesUpdated({ detail: { candles: Chart.getCandles() } });
    }

    addLog('CryptoCharts 차트 연동됨', 'info');
    if (Chart.available()) {
      syncChartIndicators();
      Chart.setSlTpDragHandler(ModuleBridge.guard('전략봇 드래그 핸들러', applySlTpDrag));
    }
    updateConfirmSlTpUi();
    autoConfirmSlTpFromStrategy();
    updateSlTpStrategyHint();
    syncPreviewFromLastSignal();
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

    ['stopLoss', 'takeProfit', 'stopLossPnl', 'takeProfitPnl'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const onSlTpChange = () => {
        readFormSettings();
        if (hasOpenPosition()) {
          syncOpenPositionSlTp();
        } else {
          slTpPreviewTouchedAt = Date.now();
          autoConfirmSlTpFromStrategy();
          syncPreviewFromLastSignal();
        }
        scheduleServerStrategySync();
        scheduleBacktest(lastCandles);
        updateUI();
      };
      el.addEventListener('change', onSlTpChange);
      el.addEventListener('input', onSlTpChange);
    });

    const slTpModePicker = $('#slTpModePicker');
    if (slTpModePicker) {
      const savedMode = localStorage.getItem(SLTP_MODE_KEY);
      if (savedMode && savedMode !== 'price') setSlTpMode(savedMode, { persist: false });
      else if (savedMode === 'price') setSlTpMode('pct', { persist: true });
      slTpModePicker.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-sltp-mode]');
        if (!btn) return;
        setSlTpMode(btn.dataset.sltpMode);
        readFormSettings();
        if (!hasOpenPosition()) {
          slTpPreviewTouchedAt = Date.now();
          autoConfirmSlTpFromStrategy();
          syncPreviewFromLastSignal();
        } else {
          syncOpenPositionSlTp();
        }
        scheduleBacktest(lastCandles);
        updateUI();
      });
    }

    $('#confirmSlTpBtn')?.addEventListener('click', () => confirmSlTp());

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
    applyChartInterval,
    updateStrategyRulesDisplay,
    exportStrategyForServer,
    getStrategySlots,
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
