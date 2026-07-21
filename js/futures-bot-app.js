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
  let exchangeUseTestnet = true;
  let showBacktest = false;
  let backtestPopupOpen = false;
  let backtestUnsub = null;
  let lastBacktestScheduleAt = 0;
  let lastBacktestMeta = { interval: '', symbol: '', lastTime: 0, count: 0 };
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
  const STRATEGY_FORM_KEY = 'crypto-charts-strategy-form';
  const MAX_STRATEGY_SLOTS = 6;
  let planFeatures = {
    pro: false,
    maxStrategySlots: 1,
    webResearch: false,
    recommendedStrategies: false,
  };
  let lastBillingSnap = null;

  function syncHeaderPlanBadge() {
    const el = document.getElementById('headerPlanBadge');
    if (!el) return;
    el.classList.toggle('hidden', !planFeatures.pro);
  }

  async function refreshPlanFeatures() {
    try {
      if (typeof FuturesApiClient === 'undefined' || !FuturesApiClient.billingMe) return lastBillingSnap;
      if (typeof AppAuth !== 'undefined' && !AppAuth.isLoggedIn?.()) {
        planFeatures = {
          pro: false,
          maxStrategySlots: 1,
          webResearch: false,
          recommendedStrategies: false,
        };
        lastBillingSnap = null;
        syncHeaderPlanBadge();
        renderFreeQuotaPanel();
        updateStrategySlotsLimitHint();
        if (typeof StrategyAI !== 'undefined') StrategyAI.syncPlanGates?.();
        return null;
      }
      const snap = await FuturesApiClient.billingMe();
      lastBillingSnap = snap;
      planFeatures = {
        pro: !!snap?.pro,
        maxStrategySlots: Number(snap?.features?.maxStrategySlots) || (snap?.pro ? MAX_STRATEGY_SLOTS : 1),
        webResearch: !!snap?.features?.webResearch,
        recommendedStrategies: !!snap?.features?.recommendedStrategies,
      };
      syncHeaderPlanBadge();
      renderFreeQuotaPanel();
      updateStrategySlotsLimitHint();
      if (typeof StrategyAI !== 'undefined') StrategyAI.syncPlanGates?.();
      return snap;
    } catch {
      syncHeaderPlanBadge();
      renderFreeQuotaPanel();
      updateStrategySlotsLimitHint();
      return lastBillingSnap;
    }
  }

  function maxAllowedStrategySlots() {
    return Math.max(1, Math.min(MAX_STRATEGY_SLOTS, Number(planFeatures.maxStrategySlots) || 1));
  }

  function getPlanFeatures() {
    return { ...planFeatures, snap: lastBillingSnap };
  }

  function formatHours(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }

  function renderFreeQuotaPanel() {
    const panel = document.getElementById('freeQuotaPanel');
    if (!panel) return;
    const loggedIn = typeof AppAuth !== 'undefined' && AppAuth.isLoggedIn?.();
    const snap = lastBillingSnap;
    const show = loggedIn && snap && !snap.pro;
    panel.classList.toggle('hidden', !show);
    if (!show) return;

    const planEl = document.getElementById('freeQuotaPlan');
    const botEl = document.getElementById('freeQuotaBotRemain');
    const gptEl = document.getElementById('freeQuotaGpt');
    const slotsEl = document.getElementById('freeQuotaSlots');
    const noteEl = document.getElementById('freeQuotaNote');

    if (planEl) planEl.textContent = 'Free';
    const remH = snap.bot?.remainingHours ?? Math.max(0, (snap.bot?.hoursLimit || 0) - (snap.bot?.hoursUsed || 0));
    const usedH = snap.bot?.hoursUsed ?? 0;
    const limH = snap.bot?.hoursLimit ?? 48;
    if (botEl) botEl.textContent = `${formatHours(remH)}시간 남음 (${formatHours(usedH)}/${formatHours(limH)}h)`;
    const gptUsed = snap.gpt?.callsUsed ?? 0;
    const gptLim = snap.gpt?.callsLimit ?? 10;
    const gptRem = snap.gpt?.remaining ?? Math.max(0, gptLim - gptUsed);
    if (gptEl) gptEl.textContent = `${gptRem}회 남음 (${gptUsed}/${gptLim})`;
    const maxSlots = maxAllowedStrategySlots();
    const usedSlots = (state.strategySlots || []).length;
    if (slotsEl) slotsEl.textContent = `${usedSlots}/${maxSlots}개`;
    if (noteEl) {
      noteEl.textContent = '추천 전략 · 멀티슬롯 · 웹 리서치는 Pro';
    }

    const mini = document.getElementById('freeQuotaMini');
    if (mini) {
      mini.classList.toggle('hidden', !show);
      if (show) {
        const maxSlots = maxAllowedStrategySlots();
        const usedSlots = (state.strategySlots || []).length;
        mini.textContent = `Free · 봇 ${formatHours(remH)}h 남음 · 슬롯 ${usedSlots}/${maxSlots} · GPT ${gptRem}회`;
      }
    }
  }

  function updateStrategySlotsLimitHint() {
    const el = document.getElementById('strategySlotsLimitHint');
    if (!el) return;
    const maxSlots = maxAllowedStrategySlots();
    const used = (state.strategySlots || []).length;
    if (planFeatures.pro) {
      el.textContent = `(${used}/${maxSlots})`;
    } else {
      el.textContent = `(${used}/${maxSlots} · Free)`;
    }
  }

  function strategyStorageSuffix() {
    try {
      const id = typeof AppAuth !== 'undefined' ? AppAuth.getUser?.()?.id : null;
      return id != null ? `:${id}` : '';
    } catch {
      return '';
    }
  }

  function storageKey(base) {
    return `${base}${strategyStorageSuffix()}`;
  }

  function readLocalJson(base) {
    try {
      let raw = localStorage.getItem(storageKey(base));
      // Fallback to legacy unscoped key (pre user-scoped persistence)
      if (!raw && strategyStorageSuffix()) raw = localStorage.getItem(base);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function writeLocalJson(base, value) {
    try {
      const key = storageKey(base);
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* ignore quota */ }
  }

  function loadStrategySlots() {
    try {
      const parsed = readLocalJson(STRATEGY_SLOTS_KEY);
      if (!parsed || !Array.isArray(parsed)) return null;
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
    writeLocalJson(STRATEGY_SLOTS_KEY, state.strategySlots);
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
      const parsed = readLocalJson(ENTRY_RULES_KEY);
      if (!parsed) return { entryRules: null, exitRules: null };
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
      writeLocalJson(ENTRY_RULES_KEY, null);
      return;
    }
    writeLocalJson(ENTRY_RULES_KEY, {
      entryRules: entryRules
        ? (window.StrategyEngine?.sanitizeEntryRules?.(entryRules) ?? entryRules)
        : null,
      exitRules: exitRules || null,
    });
  }

  function saveFormSettingsStorage() {
    readFormSettings();
    writeLocalJson(STRATEGY_FORM_KEY, {
      leverage: state.leverage,
      riskPerTradePct: state.riskPerTradePct,
      maxAccountLossPct: state.maxAccountLossPct,
      allowShort: state.allowShort,
      stopLossPct: state.stopLossPct,
      takeProfitPct: state.takeProfitPct,
      rsiPeriod: state.rsiPeriod,
      rsiOversold: state.rsiOversold,
      rsiOverbought: state.rsiOverbought,
      pollSeconds: state.pollSeconds,
      symbol: state.symbol,
      interval: state.interval,
    });
  }

  function loadFormSettingsStorage() {
    const parsed = readLocalJson(STRATEGY_FORM_KEY);
    if (!parsed || typeof parsed !== 'object') return false;
    applyFormFieldsFromPayload(parsed);
    return true;
  }

  function applyFormFieldsFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.leverage != null) setFieldValue('leverage', payload.leverage);
    if (payload.riskPerTradePct != null) setFieldValue('riskPerTrade', payload.riskPerTradePct);
    if (payload.maxAccountLossPct != null) setFieldValue('maxAccountLoss', payload.maxAccountLossPct);
    if (payload.allowShort != null) setFieldValue('allowShort', payload.allowShort);
    if (payload.stopLossPct != null) setFieldValue('stopLoss', payload.stopLossPct);
    if (payload.takeProfitPct != null) setFieldValue('takeProfit', payload.takeProfitPct);
    if (payload.rsiPeriod != null) setFieldValue('rsiPeriod', payload.rsiPeriod);
    if (payload.rsiOversold != null) setFieldValue('rsiOversold', payload.rsiOversold);
    if (payload.rsiOverbought != null) setFieldValue('rsiOverbought', payload.rsiOverbought);
    if (payload.pollSeconds != null) setFieldValue('pollSeconds', payload.pollSeconds);
    readFormSettings();
  }

  function hydrateStrategyFromPayload(payload, { source = 'local' } = {}) {
    if (!payload || typeof payload !== 'object') return false;
    applyFormFieldsFromPayload(payload);

    let slots = null;
    if (Array.isArray(payload.strategySlots) && payload.strategySlots.length) {
      slots = payload.strategySlots
        .filter((s) => s && typeof s === 'object')
        .slice(0, MAX_STRATEGY_SLOTS)
        .map((s, i) => normalizeIncomingSlot(s, i));
    }

    const entryRules = payload.entryRules
      ? (window.StrategyEngine?.sanitizeEntryRules?.(payload.entryRules) ?? payload.entryRules)
      : null;
    const exitRules = payload.exitRules
      ? (window.StrategyEngine?.sanitizeExitRules?.(payload.exitRules) ?? payload.exitRules)
      : null;

    if (slots?.length) {
      state.strategySlots = slots;
    } else if (entryRulesHaveSignals(entryRules)) {
      state.strategySlots = [{
        id: newSlotId(),
        name: '조건 1',
        enabled: true,
        entryRules,
        exitRules: exitRules ?? null,
      }];
    } else if (!slots) {
      // Keep existing slots if payload has no strategy body
      if (!entryRules && !exitRules) return false;
    }

    if (entryRules) state.entryRules = entryRules;
    if (exitRules !== undefined && payload.exitRules !== undefined) state.exitRules = exitRules;

    syncStateEntryRulesFromSlots();
    saveStrategySlots();
    saveStrategyStorage(state.entryRules, state.exitRules);
    saveFormSettingsStorage();
    renderStrategySlotsPanel();
    updateStrategyAiSlotOptions();
    updateStrategyRulesDisplay();
    updateChartIndicatorButtons();
    updateSignalDisplay();
    updateUI();
    addLog(
      source === 'server'
        ? '서버에 저장된 AI 전략 조건을 복원했습니다.'
        : '브라우저에 저장된 전략 조건을 불러왔습니다.',
      'info',
    );
    return true;
  }

  function persistStrategyLocally() {
    saveStrategySlots();
    saveStrategyStorage(state.entryRules, state.exitRules);
    saveFormSettingsStorage();
  }

  async function restoreStrategyPersistence() {
    // Never let strategy restore break Binance connect / login state.
    try {
      // 1) Local cache first (fast paint)
      loadFormSettingsStorage();
      const stored = loadStrategyStorage();
      if (stored.entryRules || stored.exitRules) {
        state.entryRules = stored.entryRules;
        state.exitRules = stored.exitRules;
      }
      migrateLegacyRulesToSlots();
      renderStrategySlotsPanel();
      updateStrategyAiSlotOptions();
      updateStrategyRulesDisplay();

      const hasLocal = entryRulesHaveSignals(state.entryRules)
        || (state.strategySlots || []).some((s) => entryRulesHaveSignals(s.entryRules));

      // 2) Server is source of truth when logged in / API available
      if (typeof AppAuth !== 'undefined' && AppAuth.isRequired() && !AppAuth.isLoggedIn()) {
        return hasLocal;
      }
      try {
        const data = await FuturesApiClient.getStrategy();
        if (data?.strategy && (data.strategy.entryRules || data.strategy.strategySlots?.length)) {
          hydrateStrategyFromPayload(data.strategy, { source: 'server' });
          return true;
        }
        // Local exists but server empty — seed server once (only if exchange session ok or ignore errors)
        if (hasLocal) {
          try {
            await syncStrategyToServer();
          } catch { /* ignore seed failures */ }
        }
      } catch {
        /* offline / old API — keep local */
      }
      return hasLocal;
    } catch (err) {
      console.warn('restoreStrategyPersistence failed', err);
      return false;
    }
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

  function lastSeriesValue(series) {
    if (!series) return null;
    const pt = Array.isArray(series) ? series.at(-1) : series;
    if (pt == null) return null;
    const v = typeof pt === 'object' ? pt.value : pt;
    return Number.isFinite(v) ? v : null;
  }

  function getIndicatorSnapshotForAi(candles) {
    const snap = {
      rsi14: null,
      ema7: null,
      ema25: null,
      ema99: null,
      macd: null,
      atr14: null,
      adx14: null,
      stoch: null,
      active: [],
    };
    if (!candles?.length || !window.TA) return snap;

    const r = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

    snap.rsi14 = r(lastSeriesValue(TA.rsi?.(candles, state.rsiPeriod || 14)), 1);
    snap.ema7 = r(lastSeriesValue(TA.emaLine?.(candles, 7)));
    snap.ema25 = r(lastSeriesValue(TA.emaLine?.(candles, 25)));
    snap.ema99 = r(lastSeriesValue(TA.emaLine?.(candles, 99)));
    snap.atr14 = r(lastSeriesValue(TA.atr?.(candles, 14)));
    if (TA.dmi) {
      snap.adx14 = r(lastSeriesValue(TA.dmi(candles, 14)?.adx), 1);
    } else {
      snap.adx14 = r(lastSeriesValue(TA.adx?.(candles, 14)), 1);
    }

    if (TA.macd) {
      const m = TA.macd(candles);
      snap.macd = {
        macd: r(lastSeriesValue(m?.macd), 4),
        signal: r(lastSeriesValue(m?.signal), 4),
        histogram: r(lastSeriesValue(m?.histogram), 4),
      };
    }
    if (TA.stochastic) {
      const s = TA.stochastic(candles);
      snap.stoch = {
        k: r(lastSeriesValue(s?.k), 1),
        d: r(lastSeriesValue(s?.d), 1),
      };
    }

    try {
      snap.active = window.CryptoCharts?.getActiveIndicators?.() || [];
    } catch (_) {
      snap.active = [];
    }
    return snap;
  }

  let lastStrategyLogBarTime = null;
  let lastStrategyLogPayload = null;

  function renderStrategyLogPanel(strategyLog) {
    const el = document.getElementById('strategyLog');
    if (!el || !strategyLog?.lines?.length) return;
    el.innerHTML = '';
    for (const line of strategyLog.lines) {
      const item = document.createElement('div');
      item.className = 'trade-log__item trade-log__item--info strategy-log__item';
      item.textContent = line;
      el.appendChild(item);
    }
  }

  function refreshStrategyLog(force = false) {
    const candles = lastCandles.length ? lastCandles : (Chart.getCandles() || []);
    if (!candles.length || !window.ChartStructure?.analyzeForAi) return null;
    const barTime = candles.at(-1)?.time;
    if (!force && barTime != null && barTime === lastStrategyLogBarTime && lastStrategyLogPayload) {
      return lastStrategyLogPayload;
    }
    const structure = ChartStructure.analyzeForAi(candles, { recentCount: 15, fvgLookback: 30 });
    const indicators = getIndicatorSnapshotForAi(candles);
    const strategyLog = window.ChartStructure.buildStrategyLog
      ? ChartStructure.buildStrategyLog(candles, structure, indicators)
      : { ...(structure.strategyLog || {}), indicators, lines: structure.strategyLog?.lines || [] };
    lastStrategyLogBarTime = barTime;
    lastStrategyLogPayload = { structure, indicators, strategyLog };
    renderStrategyLogPanel(strategyLog);
    return lastStrategyLogPayload;
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

    const packed = refreshStrategyLog(true);
    const indicators = packed?.indicators || getIndicatorSnapshotForAi(candles);
    const rsi14 = indicators.rsi14;

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
      indicators,
    };

    if (packed?.structure) {
      const structure = packed.structure;
      ctx.recentCandles15 = structure.recentCandles;
      ctx.structure = {
        swings: structure.swings,
        fvg: structure.fvg,
        divergence: structure.divergence,
        trend: structure.trend,
        trendReversal: structure.trendReversal,
      };
      ctx.strategyLog = packed.strategyLog;
    } else if (window.ChartStructure?.analyzeForAi) {
      const structure = ChartStructure.analyzeForAi(candles, { recentCount: 15, fvgLookback: 30 });
      ctx.recentCandles15 = structure.recentCandles;
      ctx.structure = {
        swings: structure.swings,
        fvg: structure.fvg,
        divergence: structure.divergence,
        trend: structure.trend,
        trendReversal: structure.trendReversal,
      };
      ctx.strategyLog = ChartStructure.buildStrategyLog?.(candles, structure, indicators) || structure.strategyLog;
    }

    ctx.timeframe = timeframeInfoForAi(state.interval);

    const hovered = window.CandleTooltip?.getLastHovered?.();
    if (hovered && hovered.hoveredAgoSec <= 300) {
      ctx.hoveredCandle = hovered;
    }

    // Recommended strategies (winRate measured on this chart) for GPT "추천전략 적용"
    if (planFeatures.recommendedStrategies) {
      if (window.__lastRecommendedStrategies?.items?.length) {
        ctx.recommendedStrategies = {
          note: window.__lastRecommendedStrategies.note,
          minWinRate: 50,
          items: window.__lastRecommendedStrategies.items.map((it) => ({
            id: it.id,
            name: it.name,
            blurb: it.blurb,
            winRate: it.winRate,
            trades: it.trades,
            totalPnlPct: it.totalPnlPct,
            ok: it.ok,
            settings: it.settings,
            gptPrompt: it.gptPrompt,
          })),
        };
      } else if (window.StrategyPresets?.listCatalog) {
        ctx.recommendedStrategies = {
          note: 'UI에서 추천 목록을 새로고침하면 승률이 채워집니다.',
          catalog: StrategyPresets.listCatalog(),
        };
      }
    }

    return ctx;
  }

  function getLastCandles() {
    return lastCandles.length ? lastCandles : (Chart.getCandles() || []);
  }

  function applyRecommendedPreset(id, options = {}) {
    if (!planFeatures.recommendedStrategies) {
      addLog('AI 추천 전략은 Pro 플랜에서 사용할 수 있습니다.', 'warn');
      return { applied: false, reason: 'AI 추천 전략은 Pro 전용입니다.' };
    }
    if (!window.StrategyPresets?.getPreset) return false;
    const preset = StrategyPresets.getPreset(id);
    if (!preset) return false;
    const measured = StrategyPresets.measurePreset(getLastCandles(), preset);
    if (!measured?.settings) return false;
    return applyStrategySettings(measured.settings, {
      patch: measured.settings,
      changedFields: Object.keys(measured.settings),
      targetSlotId: options.targetSlotId || $('#strategyAiTargetSlot')?.value || '__new__',
      summary: options.summary || `추천 전략 적용: ${measured.name}`,
    });
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
    const result = window.BacktestClient?.getLastResult?.();
    const targetTrades = state.backtestTradeCount || BACKTEST_TRADES_DEFAULT;
    if (!result?.ok || !result.stats) {
      return { current: null, targetTrades, candlesUsed: 0 };
    }
    const s = result.stats;
    return {
      current: {
        trades: s.trades,
        totalTrades: s.totalTrades,
        wins: s.wins,
        losses: s.losses,
        winRate: Math.round((s.winRate || 0) * 10) / 10,
        totalPnlPct: Math.round((s.totalPnlPct || 0) * 100) / 100,
        candlesUsed: s.candlesUsed,
        targetTrades: s.targetTrades,
        targetReached: s.targetReached,
      },
      targetTrades,
      candlesUsed: s.candlesUsed,
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

  function openBacktestPopup() {
    backtestPopupOpen = true;
    $('#backtestPopup')?.classList.remove('hidden');
    $('#backtestToggleBtn')?.classList.add('is-active');
  }

  function closeBacktestPopup() {
    backtestPopupOpen = false;
    $('#backtestPopup')?.classList.add('hidden');
    $('#backtestToggleBtn')?.classList.remove('is-active');
  }

  function toggleBacktestPopup() {
    if (backtestPopupOpen) closeBacktestPopup();
    else openBacktestPopup();
  }

  function invalidateBacktestResult(message = '전략 변경됨 — 실행 버튼을 눌러 다시 계산하세요.') {
    showBacktest = false;
    window.BacktestClient?.cancel?.();
    refreshChartMarkers();
    const statsEl = $('#backtestStats');
    if (statsEl) statsEl.textContent = message;
  }

  function getStrategySlots() {
    return state.strategySlots || [];
  }

  function refreshChartMarkers() {
    if (!Chart.available()) return;
    const candles = lastCandles.length ? lastCandles : (Chart.getCandles() || []);
    if (!showBacktest) {
      Chart.setMarkers(getSwingPivotMarkers(candles));
      Chart.clearBacktestTradeOverlays?.();
      Chart.pinBacktestChartView?.(false);
      return;
    }
    const result = window.BacktestClient?.getLastResult?.();
    if (result?.ok && result.markers?.length) {
      applyBacktestMarkers(result.markers, result.trades, candles);
    } else {
      Chart.setMarkers(getSwingPivotMarkers(candles));
      Chart.clearBacktestTradeOverlays?.();
    }
  }

  function recomputeAfterSlotsChange() {
    readFormSettings();
    updateStrategyRulesDisplay();
    updateChartIndicatorButtons();
    invalidateBacktestResult();
    updateSignalDisplay();
    scheduleServerStrategySync();
    updateUI();
  }

  function onStrategySlotsChanged({ recompute = true } = {}) {
    saveStrategySlots();
    renderStrategySlotsPanel();
    updateStrategyAiSlotOptions();
    updateStrategySlotsLimitHint();
    renderFreeQuotaPanel();
    if (recompute) recomputeAfterSlotsChange();
    else updateStrategyRulesDisplay();
  }

  function promptProUpgrade(featureLabel) {
    const msg = `${featureLabel}은(는) Pro 플랜에서 사용할 수 있습니다.\n요금제 페이지에서 Pro로 업그레이드해 주세요.`;
    window.alert(msg);
    addLog(msg.replace(/\n/g, ' '), 'warn');
    return msg;
  }

  function addStrategySlot({ name = null, entryRules = null, exitRules = null, enabled = true, silentLimit = false } = {}) {
    const maxSlots = maxAllowedStrategySlots();
    if (state.strategySlots.length >= maxSlots) {
      if (!planFeatures.pro && maxSlots < MAX_STRATEGY_SLOTS) {
        if (!silentLimit) {
          promptProUpgrade('멀티 전략 슬롯(진입 조건 추가)');
        } else {
          addLog(`무료 플랜은 진입 조건 ${maxSlots}개까지입니다. 멀티 슬롯은 Pro에서 사용할 수 있습니다.`, 'warn');
        }
      } else {
        addLog(`진입 조건은 최대 ${maxSlots}개까지 만들 수 있습니다.`, 'warn');
      }
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

    // Prefer a real slot with signals over lingering "__new__" after reload.
    if (prev && prev !== '__new__' && [...select.options].some((o) => o.value === prev)) {
      select.value = prev;
    } else if (state.strategySlots.length) {
      const withSignals = state.strategySlots.find((s) => entryRulesHaveSignals(s.entryRules));
      select.value = (withSignals || state.strategySlots[0]).id;
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
      if (merged.length >= maxAllowedStrategySlots()) return;
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
        addLog('AI 응답에 실제 변경 내용이 없어 기존 설정을 유지합니다.', 'info');
      }
      return { applied: false };
    }

    readFormSettings();
    const prevSnapshot = snapshotSettingsForCacheKey(getSettings());

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
    const entryRulesTouched = touches('entryRules') && !entryRulesRejected;
    const rulesTouched = entryRulesTouched || touches('exitRules') || touches('strategySlots');
    const strategyChanged = rulesTouched;

    updateStrategyRulesDisplay(settings, rulesHtml);
    updateChartIndicatorButtons();

    if (strategyChanged) {
      invalidateBacktestResult();
    }

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
    persistStrategyLocally();
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

  async function loadPlatformOutboundIp() {
    const box = $('#apiIpWhitelist');
    const ipEl = $('#platformOutboundIp');
    if (!box || !ipEl) return;
    try {
      const data = await FuturesApiClient.getPlatformOutboundIp();
      const ip = data?.ip || '';
      if (ip) {
        ipEl.textContent = ip;
        box.classList.remove('hidden');
      } else {
        ipEl.textContent = 'IP 조회 실패 — VPS .env에 PLATFORM_OUTBOUND_IP 설정';
        box.classList.remove('hidden');
      }
    } catch {
      ipEl.textContent = 'IP 조회 실패';
      box.classList.remove('hidden');
    }
  }

  function getApiUseTestnet() {
    return $('#apiEnv')?.value === 'testnet';
  }

  function setApiEnvSelect(useTestnet) {
    const el = $('#apiEnv');
    if (el) el.value = useTestnet ? 'testnet' : 'mainnet';
  }

  function syncExchangeEnv(useTestnet) {
    if (useTestnet === undefined || useTestnet === null) return;
    exchangeUseTestnet = Boolean(useTestnet);
    setApiEnvSelect(exchangeUseTestnet);
    // state.mode === 'testnet' means "exchange API connected" (legacy name), not Binance testnet.
    if (isTestnetMode()) {
      setModeBadge();
      updateApiServerStatus(true, true);
    }
  }

  function isTestnetMode() {
    return state.mode === 'testnet';
  }

  function exchangeEnvLabel() {
    return exchangeUseTestnet ? '테스트넷' : '실거래';
  }

  /** Live/testnet label for bot logs (not DRY_RUN). */
  function liveTradingLabel() {
    return exchangeUseTestnet ? '테스트넷 주문' : '실거래';
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

  function clampBacktestTradeCount(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return BACKTEST_TRADES_DEFAULT;
    return Math.min(BACKTEST_TRADES_MAX, Math.max(BACKTEST_TRADES_MIN, n));
  }

  // SL/TP can be entered two ways; everything downstream (strategy, preview,
  // risk sizing, server bot export) consumes stopLossPct/takeProfitPct,
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

  async function refreshTestnetStatus() {
    if (!isTestnetMode()) return null;
    const hadPosition = Boolean(testnetStatus?.position);
    testnetStatus = await FuturesApiClient.getStatus();
    if (testnetStatus?.connected && typeof testnetStatus.testnet === 'boolean') {
      // Keep badge/status in sync with the actual session (mainnet vs testnet).
      if (exchangeUseTestnet !== testnetStatus.testnet) {
        syncExchangeEnv(testnetStatus.testnet);
      }
    }
    // Adopt exchange-registered SL/TP trigger prices as the source of truth.
    const pos = testnetStatus?.position;
    if (pos) {
      if (pos.stopPrice != null) positionStopPrice = pos.stopPrice;
      if (pos.takeProfitPrice != null) positionTakeProfitPrice = pos.takeProfitPrice;
    } else if (hadPosition) {
      // Position disappeared — closed by SL/TP, liquidation, or a manual close
      // outside this browser (e.g. exchange website). Whatever the cause, a
      // still-active entry signal must not silently reopen the trade.
      if (slTpConfirmed) {
        addLog('포지션 종료 감지 — 전략 SL/TP로 재진입 대기', 'info');
      }
      if (!EntryPause.isPaused() && !EntryPause.getBlock()) {
        const closedSide = lastPendingSide || null;
        pauseAutoEntryAfterManualClose('포지션 종료 감지', closedSide);
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
    const minPauseMs = 90_000;
    // Wait out the current bar when possible; never reopen within 90s.
    const until = Math.min(
      Math.max(barEndMs, Date.now() + minPauseMs),
      Date.now() + 15 * 60_000,
    );
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
                `서버 봇이 DRY_RUN 모드입니다 — 신호만 잡히고 실제 ${exchangeEnvLabel()} 주문은 없습니다. 봇을 정지한 뒤 다시 시작하면 주문 모드로 실행됩니다.`,
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

  // Persist strategy.json whenever settings change (page reload restore),
  // and if the server bot is running, log that it will pick up the file.
  let serverStrategySyncTimer = null;
  function scheduleServerStrategySync() {
    persistStrategyLocally();
    clearTimeout(serverStrategySyncTimer);
    serverStrategySyncTimer = setTimeout(async () => {
      try {
        if (typeof AppAuth !== 'undefined' && AppAuth.isRequired() && !AppAuth.isLoggedIn()) {
          return;
        }
        await syncStrategyToServer();
        if (isTestnetMode() && serverBotActive) {
          addLog('변경된 전략을 서버에 저장했습니다 (실행 중 봇은 다음 체크부터 적용).', 'info');
        }
      } catch (err) {
        if (serverBotActive) {
          addLog(`서버 전략 저장 실패: ${err.message} — 봇을 재시작하면 적용됩니다.`, 'loss');
        }
      }
    }, 800);
  }

  function resetClientSessionState({ keepLog = false } = {}) {
    stopStatusPolling();
    state.mode = 'paper';
    testnetStatus = null;
    serverBotActive = false;
    serverBotLive = false;
    botRunning = false;
    FuturesApiClient.setConnected(false);
    $('#connectApiBtn') && ($('#connectApiBtn').disabled = false);
    $('#disconnectApiBtn') && ($('#disconnectApiBtn').disabled = true);
    $('#startBotBtn') && ($('#startBotBtn').disabled = false);
    $('#stopBotBtn') && ($('#stopBotBtn').disabled = true);
    const keyEl = $('#apiKey');
    const secretEl = $('#apiSecret');
    const envEl = $('#apiEnv');
    if (keyEl) {
      keyEl.disabled = false;
      keyEl.value = '';
      keyEl.placeholder = '';
    }
    if (secretEl) {
      secretEl.disabled = false;
      secretEl.value = '';
      secretEl.placeholder = '';
    }
    if (envEl) envEl.disabled = false;
    setModeBadge();
    if (!keepLog) {
      // Keep prior log lines but mark account switch for auditability.
      addLog('계정 세션 초기화 — 이전 사용자 API/연결 상태를 제거했습니다.', 'info');
    }
    updateApiServerStatus(false, false);
  }

  async function restoreSessionFromServer() {
    // Always clear previous account UI before applying the logged-in user's state.
    resetClientSessionState({ keepLog: true });

    const health = await FuturesApiClient.getHealth();
    if (!health?.ok) {
      updateApiServerStatus(false);
      return health;
    }

    // Never trust anonymous health credential flags when auth is required.
    if (typeof AppAuth !== 'undefined' && AppAuth.isRequired() && !AppAuth.isLoggedIn()) {
      updateApiServerStatus(true, false);
      return health;
    }

    if (health.connected) {
      state.mode = 'testnet';
      FuturesApiClient.setConnected(true);
      // Prefer session/credentials flag over .env BINANCE_TESTNET (health.testnet).
      if (typeof health.sessionTestnet === 'boolean') {
        syncExchangeEnv(health.sessionTestnet);
      }
      try {
        const st = await FuturesApiClient.getStatus();
        if (typeof st?.testnet === 'boolean') syncExchangeEnv(st.testnet);
      } catch { /* ignore */ }
      await refreshTestnetStatus();
      sessionStartEquity = await getEquity();
      $('#connectApiBtn').disabled = true;
      $('#disconnectApiBtn').disabled = false;
      $('#apiKey').disabled = true;
      $('#apiSecret').disabled = true;
      $('#apiEnv').disabled = true;
      $('#apiKey').placeholder = '서버에 저장됨';
      $('#apiSecret').placeholder = '서버에 저장됨';
      setModeBadge();
      updateApiServerStatus(true, true);
      addLog(`서버 API 세션 연결됨 (${exchangeEnvLabel()}) — 브라우저를 닫아도 유지`, 'info');
      startStatusPolling();
    } else {
      updateApiServerStatus(true, false);
      let userSaved = false;
      let savedTestnet = null;
      if (typeof AppAuth !== 'undefined' && AppAuth.isLoggedIn()) {
        try {
          const me = await FuturesApiClient.authMe();
          userSaved = Boolean(me?.credentialsSaved);
          if (userSaved) {
            $('#apiKey').placeholder = '계정에 저장됨 — 자동 유지';
            $('#apiSecret').placeholder = '계정에 저장됨 — 자동 유지';
            if (me.credentialsUseTestnet !== undefined && me.credentialsUseTestnet !== null) {
              savedTestnet = Boolean(me.credentialsUseTestnet);
              syncExchangeEnv(savedTestnet);
            }
          }
        } catch { /* ignore */ }
      }
      const authOn = typeof AppAuth !== 'undefined' && AppAuth.isRequired();
      if (!userSaved && !authOn && health.credentialsSaved) {
        $('#apiKey').placeholder = '서버에 저장됨 — 자동 유지';
        $('#apiSecret').placeholder = '서버에 저장됨 — 자동 유지';
      }

      // Auto-reconnect only for THIS user's saved keys (or legacy solo mode).
      const canAutoReconnect = userSaved || (!authOn && health.credentialsSaved);
      if (canAutoReconnect) {
        try {
          const useTestnet = typeof savedTestnet === 'boolean'
            ? savedTestnet
            : getApiUseTestnet();
          const data = await FuturesApiClient.reconnect(useTestnet);
          state.mode = 'testnet';
          FuturesApiClient.setConnected(true);
          if (typeof data?.testnet === 'boolean') syncExchangeEnv(data.testnet);
          await refreshTestnetStatus();
          sessionStartEquity = await getEquity();
          $('#connectApiBtn').disabled = true;
          $('#disconnectApiBtn').disabled = false;
          $('#apiKey').disabled = true;
          $('#apiSecret').disabled = true;
          $('#apiEnv').disabled = true;
          setModeBadge();
          updateApiServerStatus(true, true);
          addLog(`저장된 바이낸스 키로 자동 재연결됨 (${exchangeEnvLabel()})`, 'info');
          startStatusPolling();
        } catch (err) {
          addLog(`바이낸스 자동 재연결 실패: ${err.message}`, 'loss');
          // Keep login; allow manual key entry after a failed reconnect.
          FuturesApiClient.setConnected(false);
          $('#connectApiBtn') && ($('#connectApiBtn').disabled = false);
          $('#disconnectApiBtn') && ($('#disconnectApiBtn').disabled = true);
          $('#apiKey') && ($('#apiKey').disabled = false);
          $('#apiSecret') && ($('#apiSecret').disabled = false);
          $('#apiEnv') && ($('#apiEnv').disabled = false);
          updateApiServerStatus(true, false);
        }
      }
    }

    // Prefer authenticated /api/bot/status so we never adopt another user's bot.
    let myBot = health.bot;
    if (typeof AppAuth !== 'undefined' && AppAuth.isLoggedIn()) {
      try {
        myBot = await FuturesApiClient.getBotStatus();
      } catch { /* fall back to health.bot */ }
    }
    if (myBot?.running) {
      serverBotActive = true;
      serverBotLive = myBot.liveTrading !== false && !myBot.dryRun;
      botRunning = true;
      $('#startBotBtn').disabled = true;
      $('#stopBotBtn').disabled = false;
      const mode = serverBotLive ? liveTradingLabel() : 'DRY_RUN 시뮬레이션';
      addLog(`내 서버 봇 실행 중 (${mode}) — 브라우저를 닫아도 24/7 계속`, 'info');
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
      if (exchangeUseTestnet) {
        badge.textContent = '테스트넷';
        badge.className = 'paper-badge testnet-badge';
      } else {
        badge.textContent = '실거래';
        badge.className = 'paper-badge live-badge';
      }
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
    const env = exchangeEnvLabel();
    el.textContent = connected ? `API 서버: 연결됨 · ${env}` : 'API 서버: 대기 중';
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

  // ── Backtest (Worker + live-engine replay + progress stream) ─────────

  function backtestCacheKey(settings = getSettings()) {
    const interval = Chart.getState()?.interval || state.interval;
    const slots = Array.isArray(settings.strategySlots)
      ? settings.strategySlots.map((s) => ({
        enabled: s.enabled !== false,
        entryRules: s.entryRules,
        exitRules: s.exitRules,
      }))
      : null;
    const keyed = {
      entryRules: slots ? undefined : settings.entryRules,
      exitRules: settings.exitRules,
      strategySlots: slots,
      stopLossPct: settings.stopLossPct,
      takeProfitPct: settings.takeProfitPct,
      useStopLoss: settings.useStopLoss !== false,
      allowShort: settings.allowShort,
    };
    return `${state.symbol}:${interval}:${state.backtestTradeCount}:${JSON.stringify(keyed)}`;
  }

  function formatBacktestRange(stats) {
    const bars = stats.candlesUsed ?? 0;
    if (!stats.rangeFromTime || !stats.rangeToTime) return `${bars}봉`;
    const fmt = (t) => new Date(t * 1000).toLocaleString('ko-KR', {
      year: '2-digit',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${bars}봉 · 선물 · ${fmt(stats.rangeFromTime)} ~ ${fmt(stats.rangeToTime)}`;
  }

  function formatBacktestStats(stats, interval) {
    const intervalLabel = INTERVALS[interval]?.label || interval || '—';
    let countLabel = stats.targetTrades
      ? `${stats.trades}/${stats.targetTrades}회`
      : `${stats.trades}회`;
    if (stats.targetTrades && !stats.targetReached) {
      countLabel += stats.historyExhausted
        ? ` · 선물 히스토리 끝 (${(stats.candlesUsed || 0).toLocaleString()}봉)`
        : ` · ${(stats.candlesUsed || 0).toLocaleString()}봉`;
    }
    if (stats.chartVisibleTrades != null && stats.chartVisibleTrades < stats.trades) {
      countLabel += ` (차트 ${stats.chartVisibleTrades}/${stats.trades}회)`;
    }
    return (
      `백테스트 ${countLabel} (${intervalLabel} ${formatBacktestRange(stats)}) | ` +
      `승률 ${stats.winRate.toFixed(0)}% (${stats.wins}W ${stats.losses}L)`
    );
  }

  function filterByChartTime(items, chartCandles, timeKey) {
    if (!chartCandles?.length || !items?.length) return items || [];
    const minTime = chartCandles[0].time;
    const maxTime = chartCandles.at(-1).time;
    return items.filter((item) => {
      const t = item[timeKey] ?? item.time;
      return t >= minTime && t <= maxTime;
    });
  }

  function applyBacktestMarkers(markers, trades, chartCandles) {
    if (!Chart.available()) return;
    const swing = getSwingPivotMarkers(chartCandles);
    const scoped = filterByChartTime(markers, chartCandles, 'time');
    Chart.setMarkers([...scoped, ...swing].sort((a, b) => a.time - b.time));
    const visibleTrades = filterByChartTime(trades, chartCandles, 'entryTime');
    Chart.setBacktestTradeOverlays?.(visibleTrades, chartCandles);
  }

  function renderBacktestProgress(progress) {
    const statsEl = $('#backtestStats');
    if (!statsEl || !progress) return;
    if (progress.phase === 'loading' || progress.phase === 'fetch') {
      const page = progress.page != null ? ` · ${progress.page}/${progress.maxPages || '?'}페이지` : '';
      statsEl.textContent =
        `백테스트: 과거 데이터 로딩... (${progress.trades || 0}/${progress.target || state.backtestTradeCount}회, ` +
        `${(progress.candles || 0).toLocaleString()}봉${page})`;
      return;
    }
    if (progress.phase === 'compute') {
      const pct = progress.barsTotal
        ? Math.min(99, Math.round((progress.barsDone / progress.barsTotal) * 100))
        : 0;
      statsEl.textContent =
        `백테스트: 계산 중... ${pct}% (${progress.trades || 0}/${progress.target || state.backtestTradeCount}회)`;
    }
  }

  function renderBacktestResult(result) {
    const statsEl = $('#backtestStats');
    if (!result?.ok) {
      if (result?.cancelled) return;
      if (statsEl) {
        statsEl.textContent = result?.error
          ? `백테스트 실패: ${result.error}`
          : `백테스트: — (${result?.reason || '실패'})`;
      }
      refreshChartMarkers();
      return;
    }

    const chartCandles = Chart.getCandles() || lastCandles;
    const visibleTrades = filterByChartTime(result.trades, chartCandles, 'entryTime');
    const stats = {
      ...result.stats,
      chartVisibleTrades: visibleTrades.length,
    };
    if (showBacktest) {
      applyBacktestMarkers(result.markers, result.trades, chartCandles);
    } else {
      Chart.setMarkers(getSwingPivotMarkers(chartCandles));
      Chart.clearBacktestTradeOverlays?.();
    }
    if (statsEl) statsEl.innerHTML = formatBacktestStats(stats, result.interval || state.interval);
  }

  function scheduleBacktest() {
    if (!window.BacktestClient) return;

    readFormSettings();
    const candles = lastCandles.length ? lastCandles : (Chart.getCandles() || []);
    if (!candles.length) {
      const statsEl = $('#backtestStats');
      if (statsEl) statsEl.textContent = '백테스트: 차트 데이터 로딩 중...';
      return;
    }

    const settings = getSettings();
    const cacheKey = backtestCacheKey(settings);
    const now = Date.now();
    if (now - lastBacktestScheduleAt < 800) return;
    lastBacktestScheduleAt = now;

    lastBacktestMeta = {
      interval: Chart.getState()?.interval || state.interval,
      symbol: state.symbol,
      lastTime: candles.at(-1)?.time ?? 0,
      count: candles.length,
    };

    const statsEl = $('#backtestStats');
    if (statsEl && !BacktestClient.isRunning()) {
      statsEl.textContent = '백테스트: 대기 중...';
    }

    BacktestClient.run({
      candles,
      settings,
      symbol: state.symbol,
      interval: Chart.getState()?.interval || state.interval,
      maxTrades: state.backtestTradeCount || BACKTEST_TRADES_DEFAULT,
      expand: true,
    }, { cacheKey, force: true }).then((result) => {
      if (result?.cancelled) return;
      renderBacktestResult(result);
    });
  }

  async function runBacktest() {
    const btn = $('#runBacktestBtn');
    if (btn) btn.disabled = true;
    openBacktestPopup();
    showBacktest = true;
    try {
      if (!Chart.available()) {
        const statsEl = $('#backtestStats');
        if (statsEl) statsEl.textContent = '백테스트: — (차트 미연동)';
        return;
      }
      syncFromChart();
      let chartCandles = Chart.getCandles() || lastCandles;
      if (!chartCandles.length) {
        await Chart.reloadChart();
        syncFromChart();
        chartCandles = Chart.getCandles() || lastCandles;
      }
      lastCandles = chartCandles;
      scheduleBacktest();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function bindBacktestClient() {
    if (!window.BacktestClient || backtestUnsub) return;
    backtestUnsub = BacktestClient.subscribe((event) => {
      if (event.type === 'progress') renderBacktestProgress(event.progress);
      if (event.type === 'done' && event.result) renderBacktestResult(event.result);
      if (event.type === 'error') {
        const statsEl = $('#backtestStats');
        if (statsEl) statsEl.textContent = `백테스트 실패: ${event.error}`;
      }
    });
  }

  function onChartCandlesUpdated(e) {
    lastCandles = e.detail?.candles || Chart.getCandles() || [];
    state.interval = e.detail?.interval || Chart.getState()?.interval || state.interval;
    state.lastPrice = lastCandles.at(-1)?.close || Chart.getPrice() || 0;
    if (showBacktest) refreshChartMarkers();
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
    refreshStrategyLog(false);
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

    // DRY_RUN server bot never places orders — do not pretend the client will.
    if (serverBotActive && !serverBotLive) {
      logEntrySkipOnce(
        `dry:${key}`,
        `${result.signal} 신호 — DRY_RUN(시뮬레이션). 봇 정지 후 다시 시작하면 실거래 모드로 실행됩니다`,
      );
      return;
    }

    if (serverBotActive && serverEntryGate?.active) {
      const reason = serverEntryGate.reason === 'manual_close'
        ? '수동 청산 후 재진입 보류'
        : '진입 일시정지';
      logEntrySkipOnce(`gate:${key}`, `${result.signal} 신호 — 서버 ${reason} (게이트 활성)`);
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
      // Browser open: enter immediately from the chart signal. Server bot (if
      // running) skips when a position already exists — avoids waiting on the
      // server poll while the UI already shows a live entry signal.
      const via = serverBotActive ? '차트 신호 → 즉시 진입' : '즉시 진입';
      addLog(`${result.signal} 신호 감지 — ${via} (${result.reason})`, 'info');
      await executeSignal(result);
      if (hasOpenPosition()) {
        lastAutoEntryKey = key;
      } else {
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
    if (typeof GuestGate !== 'undefined' && !GuestGate.requireLogin('API 연결')) return;
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
      const useTestnet = getApiUseTestnet();
      let data;
      if (!apiKey || !apiSecret) {
        let saved = false;
        if (typeof AppAuth !== 'undefined' && AppAuth.isLoggedIn()) {
          try {
            const me = await FuturesApiClient.authMe();
            saved = Boolean(me?.credentialsSaved);
          } catch { /* ignore */ }
        }
        if (!saved) {
          const health = await FuturesApiClient.getHealth();
          saved = Boolean(health?.credentialsSaved);
        }
        if (!saved) {
          addLog('API Key와 Secret을 입력하세요.', 'loss');
          return;
        }
        data = await FuturesApiClient.reconnect(useTestnet);
        addLog(`저장된 API 키로 재연결 (${useTestnet ? '테스트넷' : '실거래'})`, 'info');
      } else {
        if (typeof AppAuth !== 'undefined' && AppAuth.isRequired() && !AppAuth.isLoggedIn()) {
          addLog('로그인 후 API 키를 연결하세요.', 'loss');
          return;
        }
        data = await FuturesApiClient.connect(apiKey, apiSecret, useTestnet);
      }
      state.mode = 'testnet';
      syncExchangeEnv(typeof data.testnet === 'boolean' ? data.testnet : useTestnet);
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
      $('#apiEnv').disabled = true;
      $('#apiKey').placeholder = data.perUser ? '계정에 암호화 저장됨' : '서버에 저장됨';
      $('#apiSecret').placeholder = data.perUser ? '계정에 암호화 저장됨' : '서버에 저장됨';
      setModeBadge();
      updateApiServerStatus(true, true);
      startStatusPolling();
      const storeHint = data.perUser ? '계정 암호화 저장' : '서버 .env 저장';
      addLog(`연결 성공 (${exchangeEnvLabel()}) — 잔고 $${data.balance.toFixed(2)} USDT (${storeHint})`, 'info');
      updateUI();
    } catch (err) {
      String(err.message || err)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line, i) => addLog(i === 0 ? `연결 실패: ${line}` : line, 'loss'));
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
    $('#apiEnv').disabled = false;
    $('#apiKey').placeholder = '';
    $('#apiSecret').placeholder = '';
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

    const feePct = plan?.feePct ?? RiskSizing?.TRADING_FEE_PCT ?? 0.1;
    const effSl = plan?.effectiveStopLossPct
      ?? (slPct != null && RiskSizing?.effectiveStopLossPct
        ? RiskSizing.effectiveStopLossPct(slPct, feePct)
        : null);
    $('#notionalInfo').innerHTML =
      `증거금 $${marginPreview.toFixed(0)} (${state.leverage}x) · ` +
      `<span class="text-muted">SL ${slPct != null ? slPct.toFixed(2) : '—'}%` +
      `${effSl != null ? `+수수료${feePct}%→${effSl.toFixed(2)}%` : ''} · ` +
      `손절 시 -$${lossAtSl.toFixed(2)} (목표 -$${targetLoss.toFixed(2)}, ${lossPctOfEquity.toFixed(2)}%)</span>`;

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

    // Drop leftover browser-side pauses so a fresh start can enter on the
    // current signal instead of waiting out a previous manual-close gate.
    if (typeof EntryPause !== 'undefined') EntryPause.clear();
    lastAutoEntryKey = null;
    autoEntryRetryAt = 0;
    autoConfirmSlTpFromStrategy();

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
        serverEntryGate = null;
        botRunning = true;
        $('#startBotBtn').disabled = true;
        $('#stopBotBtn').disabled = false;
        startStatusPolling();
        addLog(
          `서버 봇 시작 (${liveTradingLabel()}) — BTC ${INTERVALS[state.interval]?.label || state.interval}, ${state.leverage}x · 브라우저에서도 신호 즉시 진입`,
          'info',
        );
        // Enter right away if the chart already shows a live signal.
        updateSignalDisplay();
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
      updateSignalDisplay();
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
      addLog('수동 주문은 API 연결 후 사용할 수 있습니다.', 'info');
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
  // running bot: pause auto entries until the current bar closes (min 90s).
  function pauseAutoEntryAfterManualClose(reason = '수동 청산', closedSide = null) {
    const side = closedSide || testnetStatus?.position?.side || lastPendingSide || null;
    const block = buildManualCloseBlock(side);
    EntryPause.blockManualClose(block);
    // Prevent the same-bar signal key from being treated as a fresh entry.
    if (side && block.barTime != null) {
      lastAutoEntryKey = `${side}:${block.barTime}`;
    }
    autoEntryRetryAt = Math.max(autoEntryRetryAt, block.until);
    const secs = Math.max(1, Math.ceil((block.until - Date.now()) / 1000));
    addLog(
      `${reason} — ${secs}초(또는 현재 봉 종료)까지 자동 재진입을 멈춥니다.`,
      'info',
    );
    return block;
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
          // Local + server pause BEFORE the exchange close so neither the
          // browser bot nor the headless bot can race a reopen.
          pauseAutoEntryAfterManualClose('수동 청산', side || null);
          resetSlTpConfirm();
          if (serverBotActive) {
            try {
              await FuturesApiClient.pauseBotEntry?.();
            } catch { /* closePosition also pauses when manual=true */ }
          }
          await FuturesApiClient.closePosition({
            manual: true,
            barTime,
            blockedSignal: side || null,
          });
          clearPositionStop();
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
      pauseAutoEntryAfterManualClose('수동 청산', closedSide);
      const r = FuturesPaper.closePosition(price, '수동 청산');
      if (r.ok) {
        clearPositionStop();
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
      addLog('거래소 연결 모드에서는 모의 계좌 초기화를 사용할 수 없습니다.', 'info');
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
          // Keep server strategy interval in sync if an explicit TF is chosen
          // while the bot is already running (chart mode follows live chart).
          if (btn.dataset.botInterval !== 'chart' && INTERVALS[btn.dataset.botInterval]) {
            state.interval = btn.dataset.botInterval;
            scheduleServerStrategySync();
          }
        }
      });
    }

    $('#backtestToggleBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBacktestPopup();
    });
    $('#backtestPopupClose')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeBacktestPopup();
    });
    $('#runBacktestBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      runBacktest();
    });

    const backtestCountEl = $('#backtestTradeCount');
    if (backtestCountEl) {
      const onCount = () => {
        readFormSettings();
        backtestCountEl.value = String(state.backtestTradeCount);
      };
      backtestCountEl.addEventListener('change', onCount);
      backtestCountEl.addEventListener('input', onCount);
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && backtestPopupOpen) closeBacktestPopup();
    });
  }

  async function init() {
    bindBacktestClient();
    bindUiEvents();

    try {
      await AppAuth.init();
      const bootHealth = await FuturesApiClient.getHealth();
      await AppAuth.refreshFromHealth(bootHealth);
      updateApiServerStatus(Boolean(bootHealth?.ok), Boolean(bootHealth?.connected));
      await loadPlatformOutboundIp();
      if (typeof GuestGate !== 'undefined') {
        GuestGate.bindTradingLocks?.();
        GuestGate.syncTradingGuestUi?.();
      }
      const guestMode = AppAuth.isRequired() && !AppAuth.isLoggedIn();
      if (guestMode) {
        // Guest: chart viewing allowed; bot/API/GPT locked via GuestGate + UI.
        addLog('비로그인 — 차트만 이용 가능합니다. 자동매매·봇·GPT는 로그인 후 사용하세요.', 'warn');
        syncExchangeEnv(false);
        setModeBadge();
        updateChartIndicatorButtons();
        if ((Chart.getCandles() || []).length) {
          onChartCandlesUpdated({ detail: { candles: Chart.getCandles() } });
        }
        if (Chart.available()) syncChartIndicators();
        addLog('Orbinex 차트 연동됨 (게스트)', 'info');
      } else {
        if (AppAuth.isRequired()) syncExchangeEnv(false);

        readFormSettings();
        $('#addStrategySlotBtn')?.addEventListener('click', () => {
          const maxSlots = maxAllowedStrategySlots();
          if (!planFeatures.pro && state.strategySlots.length >= maxSlots) {
            promptProUpgrade('멀티 전략 슬롯(진입 조건 추가)');
            return;
          }
          const slot = addStrategySlot();
          if (slot) {
            addLog(`진입 조건 [${slot.name}] 추가됨 — GPT에게 전략을 설명해 저장하세요.`, 'info');
            onStrategySlotsChanged({ recompute: false });
          }
        });
        updateChartIndicatorButtons();
        updateMacdLineFilterUi();
        updateRsiEntryFilterUi();
        updateSwingLevelsUi();
        sessionStartEquity = await getEquity();

        await restoreSessionFromServer();
        await restoreStrategyPersistence();
        await refreshPlanFeatures();
        setModeBadge();

        if ((Chart.getCandles() || []).length) {
          onChartCandlesUpdated({ detail: { candles: Chart.getCandles() } });
        }

        addLog('Orbinex 차트 연동됨', 'info');
        if (Chart.available()) {
          syncChartIndicators();
          Chart.setSlTpDragHandler(ModuleBridge.guard('전략봇 드래그 핸들러', applySlTpDrag));
        }
        updateConfirmSlTpUi();
        autoConfirmSlTpFromStrategy();
        updateSlTpStrategyHint();
        syncPreviewFromLastSignal();
        if (await FuturesApiClient.checkServer()) addLog('API 서버 감지 — 실거래/테스트넷 키 연결 가능', 'info');
      }
    } catch (err) {
      console.error('FuturesBotApp.init failed', err);
      updateApiServerStatus(await FuturesApiClient.checkServer().catch(() => false), false);
      addLog(`앱 초기화 오류: ${err?.message || err}`, 'loss');
    }

    document.querySelectorAll('[data-chart-ind]').forEach((btn) => {
      btn.addEventListener('click', () => toggleChartIndicator(btn.dataset.chartInd));
    });
    $('#hideUnusedIndicatorsBtn')?.addEventListener('click', hideUnusedChartIndicators);
    $('#exportStrategyBtn')?.addEventListener('click', exportStrategyForServer);

    $('#connectApiBtn')?.addEventListener('click', () => {
      if (typeof GuestGate !== 'undefined' && !GuestGate.requireLogin('API 연결')) return;
      connectApi();
    });
    $('#disconnectApiBtn')?.addEventListener('click', disconnectApi);
    $('#copyPlatformIpBtn')?.addEventListener('click', async () => {
      const ip = $('#platformOutboundIp')?.textContent?.trim();
      if (!ip || ip.includes('조회')) return;
      try {
        await navigator.clipboard.writeText(ip);
        addLog(`서버 IP 복사됨: ${ip} — Binance Trusted IPs에 붙여넣기`, 'info');
      } catch {
        addLog(`서버 IP: ${ip}`, 'info');
      }
    });
    $('#startBotBtn').addEventListener('click', () => {
      if (typeof GuestGate !== 'undefined' && !GuestGate.requireLogin('봇 시작')) return;
      startBot();
    });
    $('#stopBotBtn').addEventListener('click', stopBot);
    $('#closeBtn').addEventListener('click', () => {
      if (typeof GuestGate !== 'undefined' && !GuestGate.requireLogin('수동 청산')) return;
      manualClose();
    });
    $('#resetBtn')?.addEventListener('click', () => {
      if (typeof GuestGate !== 'undefined' && !GuestGate.requireLogin('모의 초기화')) return;
      resetWallet();
    });

    const macdLineFilterEl = $('#useMacdLineFilter');
    if (macdLineFilterEl) {
      macdLineFilterEl.addEventListener('change', () => {
        updateMacdLineFilterUi();
        updateChartIndicatorButtons();
        updateUI();
      });
    }

    $('#useMacd')?.addEventListener('change', () => {
      readFormSettings();
      if (!isStrategyUsingMacd()) chartIndicators.macd = false;
      syncChartIndicators();
    });

    const rsiEntryFilterEl = $('#useRsiEntryFilter');
    if (rsiEntryFilterEl) {
      rsiEntryFilterEl.addEventListener('change', () => {
        updateRsiEntryFilterUi();
        updateUI();
      });
    }

    const swingLevelsEl = $('#useSwingLevels');
    if (swingLevelsEl) {
      swingLevelsEl.addEventListener('change', () => {
        updateSwingLevelsUi();
        updateUI();
      });
    }

    const swingStopEl = $('#useSwingStopLoss');
    if (swingStopEl) {
      swingStopEl.addEventListener('change', () => {
        updateSwingLevelsUi();
        updateUI();
      });
    }

    const showSwingOnChartEl = $('#showSwingOnChart');
    if (showSwingOnChartEl) {
      showSwingOnChartEl.addEventListener('change', () => {
        updateSwingLevelsUi();
        updateSwingChartOverlay(lastCandles);
        refreshChartMarkers();
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
    applyRecommendedPreset,
    getLastCandles,
    applyChartInterval,
    updateStrategyRulesDisplay,
    exportStrategyForServer,
    getStrategySlots,
    restoreSessionFromServer,
    restoreStrategyPersistence,
    resetClientSessionState,
    refreshPlanFeatures,
    getPlanFeatures,
    renderFreeQuotaPanel,
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
