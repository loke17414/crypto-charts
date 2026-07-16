/* Pure backtest orchestration — works in main thread or Worker.
 * Replay uses FuturesStrategy.runReplay (live engine path).
 * History expands newest → past via Binance futures klines. */
(function (root) {
  'use strict';

  const FUTURES_API = 'https://fapi.binance.com/fapi/v1';
  const PAGE_SIZE = 1000;
  const HARD_MAX_PAGES = 300;
  const PAGE_DELAY_MS = 150;
  const NO_GAIN_LIMIT = 4;
  const MIN_PAGES_BEFORE_NO_GAIN = 8;

  const INTERVAL_SECONDS = {
    '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
    '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800,
    '12h': 43200, '1d': 86400,
  };

  function closedCandlesOnly(candles, interval) {
    if (!candles?.length) return candles || [];
    const sec = INTERVAL_SECONDS[interval];
    if (!sec) return candles;
    const nowSec = Math.floor(Date.now() / 1000);
    return candles.at(-1).time + sec > nowSec ? candles.slice(0, -1) : candles;
  }

  function mergeCandles(existing, older) {
    const byTime = new Map();
    [...older, ...existing].forEach((c) => byTime.set(c.time, c));
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  function mapKlines(raw) {
    return raw.map((k) => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  async function fetchPage(symbol, interval, endTimeMs = null) {
    let url = `${FUTURES_API}/klines?symbol=${symbol}&interval=${interval}&limit=${PAGE_SIZE}`;
    if (endTimeMs != null) url += `&endTime=${endTimeMs}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Klines fetch failed (${res.status})`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Invalid klines response');
    return mapKlines(data);
  }

  function barsPerTradeHint(interval) {
    return { '1m': 25, '5m': 20, '15m': 18, '1h': 12, '4h': 10, '1d': 8 }[interval] || 15;
  }

  function maxPagesForTarget(targetTrades) {
    return Math.min(HARD_MAX_PAGES, Math.max(10, Math.ceil(targetTrades / 2) + 5));
  }

  function countClosedTrades(candles, settings, targetTrades) {
    const { stats } = FuturesStrategy.runReplay(candles, settings, {
      maxTrades: targetTrades,
      skipMarkers: true,
    });
    return stats.totalTrades ?? stats.trades;
  }

  async function expandHistory({
    symbol,
    interval,
    settings,
    targetTrades,
    seedCandles,
    shouldStop,
    onProgress,
  }) {
    let candles = seedCandles?.length ? [...seedCandles] : await fetchPage(symbol, interval);
    if (!candles.length) {
      return { candles, exhausted: true, trades: 0 };
    }

    let pagesUsed = seedCandles?.length
      ? Math.max(1, Math.ceil(candles.length / PAGE_SIZE))
      : 1;
    let found = countClosedTrades(candles, settings, targetTrades);
    let budget = maxPagesForTarget(targetTrades);
    let exhausted = false;
    let noGainRounds = 0;

    const report = (extra = {}) => {
      onProgress?.({
        phase: 'loading',
        trades: found,
        target: targetTrades,
        candles: candles.length,
        page: pagesUsed,
        maxPages: budget,
        exhausted,
        ...extra,
      });
    };
    report();

    while (found < targetTrades && pagesUsed < budget && !exhausted) {
      if (shouldStop?.()) break;
      const beforeLen = candles.length;
      const beforeFound = found;
      const remaining = targetTrades - found;
      const barsPerTrade = found > 0
        ? candles.length / found
        : barsPerTradeHint(interval) * 3;
      const neededBars = Math.ceil(remaining * barsPerTrade * 1.35) + PAGE_SIZE;
      const estPages = Math.ceil(neededBars / PAGE_SIZE);
      budget = Math.min(HARD_MAX_PAGES, Math.max(budget, pagesUsed + estPages));
      const pagesToFetch = Math.max(1, Math.min(estPages, budget - pagesUsed, 10));

      report({ phase: 'fetch' });
      for (let n = 0; n < pagesToFetch; n++) {
        if (shouldStop?.()) break;
        if (n > 0) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
        const oldestMs = candles[0].time * 1000 - 1;
        const older = await fetchPage(symbol, interval, oldestMs);
        pagesUsed += 1;
        if (!older.length) {
          exhausted = true;
          break;
        }
        const next = mergeCandles(candles, older);
        if (next.length <= candles.length || older.length < PAGE_SIZE / 10) {
          candles = next;
          exhausted = true;
          break;
        }
        candles = next;
      }

      if (candles.length === beforeLen) {
        exhausted = true;
        break;
      }

      report({ phase: 'compute' });
      found = countClosedTrades(candles, settings, targetTrades);
      if (found >= targetTrades) break;

      if (found <= beforeFound) {
        noGainRounds += 1;
        if (noGainRounds >= NO_GAIN_LIMIT && pagesUsed >= MIN_PAGES_BEFORE_NO_GAIN) {
          exhausted = true;
          break;
        }
      } else {
        noGainRounds = 0;
      }
      report();
    }

    if (found < targetTrades && pagesUsed >= budget) exhausted = true;
    report({ loading: false });
    return { candles, exhausted, trades: found };
  }

  async function runBacktestJob(payload, { shouldStop, onProgress } = {}) {
    const {
      candles: rawCandles,
      settings,
      symbol,
      interval,
      maxTrades = 100,
      expand = true,
    } = payload;

    const seed = closedCandlesOnly(rawCandles || [], interval);
    if (!seed.length) {
      return {
        ok: false,
        reason: '차트 데이터 없음',
        stats: null,
        trades: [],
        markers: [],
      };
    }

    let source = seed;
    let historyExhausted = false;

    let probe = FuturesStrategy.runReplay(seed, settings, {
      maxTrades,
      skipMarkers: true,
      shouldStop,
    });

    if (expand
      && !probe.stats.targetReached
      && symbol
      && !shouldStop?.()) {
      onProgress?.({
        phase: 'loading',
        trades: probe.stats.totalTrades ?? probe.stats.trades,
        target: maxTrades,
        candles: seed.length,
      });
      const expanded = await expandHistory({
        symbol,
        interval,
        settings,
        targetTrades: maxTrades,
        seedCandles: seed,
        shouldStop,
        onProgress,
      });
      if (shouldStop?.()) {
        return { ok: false, cancelled: true, stats: null, trades: [], markers: [] };
      }
      source = expanded.candles;
      historyExhausted = expanded.exhausted === true;
    }

    const result = FuturesStrategy.runReplay(source, settings, {
      maxTrades,
      skipMarkers: false,
      shouldStop,
      onProgress,
    });

    if (result.stats.cancelled || shouldStop?.()) {
      return {
        ok: false,
        cancelled: true,
        stats: result.stats,
        trades: result.trades,
        markers: result.markers,
        candlesUsed: source.length,
      };
    }

    return {
      ok: true,
      stats: {
        ...result.stats,
        historyExhausted,
      },
      trades: result.trades,
      markers: result.markers,
      candlesUsed: source.length,
      interval,
      symbol,
    };
  }

  const BacktestEngine = {
    closedCandlesOnly,
    expandHistory,
    runBacktestJob,
    countClosedTrades,
  };

  root.BacktestEngine = BacktestEngine;
})(typeof self !== 'undefined' ? self : window);
