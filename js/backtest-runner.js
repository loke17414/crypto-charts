/* Isolated backtest orchestration — errors here must never stop the bot, GPT, or chart.
 * futures-bot-app delegates all backtest scheduling/compute to this module and only
 * handles chart display through ModuleBridge.chart (already fault-isolated). */
const BacktestRunner = (() => {
  const INTERVAL_SECONDS = {
    '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
    '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800,
    '12h': 43200, '1d': 86400,
  };

  let deps = null;
  let runId = 0;
  let historyCache = null;
  let lastRenderedKey = null;
  let inFlightKey = null;
  let inFlightAt = 0;
  let debounceTimer = null;
  let explicitRunActive = false;
  let lastError = null;

  function configure(hooks) {
    deps = hooks;
  }

  function closedCandlesOnly(candles, interval) {
    if (!candles?.length) return candles || [];
    const sec = INTERVAL_SECONDS[interval];
    if (!sec) return candles;
    const nowSec = Math.floor(Date.now() / 1000);
    return candles.at(-1).time + sec > nowSec ? candles.slice(0, -1) : candles;
  }

  function mergeCandlesByTime(older, newer) {
    const byTime = new Map();
    [...older, ...newer].forEach((c) => byTime.set(c.time, c));
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  function cacheKey(interval, targetTrades, settings) {
    return deps.cacheKey(interval, targetTrades, settings);
  }

  function isLoading() {
    return Boolean(inFlightKey);
  }

  function getLastError() {
    return lastError;
  }

  function invalidate({ message = null } = {}) {
    runId += 1;
    historyCache = null;
    lastRenderedKey = null;
    inFlightKey = null;
    explicitRunActive = false;
    lastError = null;
    deps.onInvalidate?.(message);
  }

  async function resolveCandles(chartCandles, settings, targetTrades, onProgress, localRunId) {
    const interval = deps.getInterval();
    const rawSource = chartCandles?.length ? chartCandles : (deps.getChartCandles() || []);
    const chartSource = closedCandlesOnly(rawSource, interval);

    let stats;
    try {
      ({ stats } = FuturesStrategy.backtest(chartSource, settings, { maxTrades: targetTrades }));
    } catch (err) {
      throw new Error(`백테스트 엔진 오류: ${err.message}`);
    }

    if (stats.trades >= targetTrades || !window.BacktestLoader) {
      return { source: chartSource, fromCache: false };
    }

    const key = cacheKey(interval, targetTrades, settings);
    let seed = chartSource;
    let seedTrades = stats.trades;

    if (historyCache?.key === key) {
      const merged = mergeCandlesByTime(historyCache.candles, chartSource);
      const exhausted = historyCache.exhausted === true;
      historyCache = { key, candles: merged, exhausted };
      const cachedStats = FuturesStrategy.backtest(merged, settings, { maxTrades: targetTrades }).stats;
      if (cachedStats.trades >= targetTrades || exhausted) {
        return { source: merged, fromCache: true };
      }
      seed = merged;
      seedTrades = cachedStats.trades;
    }

    onProgress?.({ phase: 'loading', trades: seedTrades, target: targetTrades, candles: seed.length });

    const extended = await BacktestLoader.loadForTargetTrades(
      deps.getSymbol(),
      interval,
      settings,
      targetTrades,
      (progress) => {
        if (localRunId !== runId) return;
        onProgress?.({ phase: 'loading', ...progress });
      },
      seed,
      () => localRunId !== runId,
    );

    const cancelled = localRunId !== runId;
    if (extended.length > seed.length || !cancelled) {
      historyCache = {
        key,
        candles: extended,
        exhausted: !cancelled && extended.length <= seed.length,
      };
    }
    if (cancelled) return null;
    return { source: extended, fromCache: false };
  }

  async function compute(chartCandles, { force = false, focusChart = false } = {}) {
    lastError = null;
    deps.readFormSettings?.();
    const settings = deps.getSettings();
    const interval = deps.getInterval();
    const targetTrades = deps.getTargetTrades();
    const source = chartCandles?.length ? chartCandles : (deps.getChartCandles() || []);
    const minRequired = FuturesStrategy.minBars(settings);

    if (!source.length || source.length < minRequired) {
      const reason = !source.length
        ? '차트 데이터 없음 — 잠시 후 다시 시도'
        : `${source.length}봉 (최소 ${minRequired}봉 필요)`;
      return { ok: false, reason, interval, settings, targetTrades };
    }

    const pendingKey = cacheKey(interval, targetTrades, settings);
    if (!force && !explicitRunActive
      && inFlightKey === pendingKey
      && Date.now() - inFlightAt < 180_000) {
      return { ok: false, skipped: true, reason: 'in-flight', interval, settings, targetTrades };
    }

    inFlightKey = pendingKey;
    inFlightAt = Date.now();
    const localRunId = ++runId;

    try {
      const resolved = await resolveCandles(
        chartCandles,
        settings,
        targetTrades,
        (p) => deps.onProgress?.(p),
        localRunId,
      );
      if (!resolved || localRunId !== runId) {
        return { ok: false, cancelled: true, interval, settings, targetTrades };
      }

      const { source: btSource } = resolved;
      const { markers, stats, trades } = FuturesStrategy.backtest(btSource, settings, { maxTrades: targetTrades });

      let displayCandles = chartCandles?.length ? chartCandles : btSource;
      if (focusChart && trades.length && displayCandles.length) {
        const earliestEntry = Math.min(...trades.map((t) => t.entryTime));
        const chartData = deps.getChartCandles() || displayCandles;
        if (earliestEntry < chartData[0].time) {
          const barSec = INTERVAL_SECONDS[interval] || 900;
          const needBars = Math.ceil((chartData[0].time - earliestEntry) / barSec);
          const maxPages = Math.min(60, Math.ceil(needBars / 1000) + 2);
          await deps.loadChartHistoryUntil?.(earliestEntry, maxPages);
        }
        displayCandles = deps.getChartCandles() || displayCandles;
      }

      if (localRunId !== runId) {
        return { ok: false, cancelled: true, interval, settings, targetTrades };
      }

      lastRenderedKey = pendingKey;
      return {
        ok: true,
        interval,
        settings,
        targetTrades,
        stats: { ...stats, chartVisibleTrades: null },
        trades,
        markers,
        btSource,
        displayCandles,
        pendingKey,
      };
    } catch (err) {
      lastError = err;
      console.error('[BacktestRunner] compute failed:', err);
      return { ok: false, error: err, interval, settings, targetTrades };
    } finally {
      if (inFlightKey === pendingKey) inFlightKey = null;
      if (explicitRunActive && localRunId === runId) explicitRunActive = false;
    }
  }

  function scheduleRefresh(chartCandles) {
    if (explicitRunActive) return;
    clearTimeout(debounceTimer);
    deps.readFormSettings?.();
    const pendingKey = deps.getCacheKey?.();
    if (deps.getShowBacktest?.()
      && lastRenderedKey != null
      && pendingKey !== lastRenderedKey) {
      invalidate({ message: '백테스트: 조건 변경 — 재계산 중...' });
    }
    debounceTimer = setTimeout(() => {
      deps.onCompute?.(chartCandles, { force: false, focusChart: false });
    }, 600);
  }

  async function runExplicit(chartCandles) {
    explicitRunActive = true;
    inFlightKey = null;
    return deps.onCompute?.(chartCandles, { force: true, focusChart: true });
  }

  function snapshotFromCandles(candles, settings, targetTrades, interval) {
    const closed = closedCandlesOnly(candles, interval);
    if (!closed.length || !window.FuturesStrategy?.backtest) {
      return { current: null, targetTrades, candlesUsed: 0 };
    }
    try {
      const { stats } = FuturesStrategy.backtest(closed, settings, { maxTrades: targetTrades });
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
        candlesUsed: closed.length,
      };
    } catch (err) {
      console.error('[BacktestRunner] snapshot failed:', err);
      return { current: null, targetTrades, candlesUsed: closed.length, error: err.message };
    }
  }

  function clearHistoryCache() {
    historyCache = null;
  }

  return {
    configure,
    scheduleRefresh,
    runExplicit,
    compute,
    invalidate,
    snapshotFromCandles,
    closedCandlesOnly,
    isLoading,
    getLastError,
    clearHistoryCache,
  };
})();

window.BacktestRunner = BacktestRunner;
