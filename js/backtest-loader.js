/* Fetch extended USDT-M futures kline history until backtest reaches target trade count */
const BacktestLoader = (() => {
  const FUTURES_API = 'https://fapi.binance.com/fapi/v1';
  const PAGE_SIZE = 1000;
  const HARD_MAX_PAGES = 300;
  // 연속 페이지 요청 사이 지연 — 바이낸스 레이트리밋(가중치/분)을 넘지 않게.
  const PAGE_FETCH_DELAY_MS = 150;

  function maxPagesForTarget(targetTrades) {
    return Math.min(HARD_MAX_PAGES, Math.max(10, Math.ceil(targetTrades / 2) + 5));
  }

  function barsPerTradeHint(interval) {
    return {
      '1m': 25,
      '5m': 20,
      '15m': 18,
      '1h': 12,
      '4h': 10,
      '1d': 8,
    }[interval] || 15;
  }

  function mapKlines(raw) {
    if (window.KlineLoader?.mapKlines) return KlineLoader.mapKlines(raw);
    return raw.map((k) => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  function mergeCandles(existing, older) {
    if (window.KlineLoader?.mergeCandles) {
      return KlineLoader.mergeCandles(existing, older);
    }
    const byTime = new Map();
    [...older, ...existing].forEach((c) => byTime.set(c.time, c));
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  async function fetchPage(symbol, interval, endTimeMs = null) {
    if (window.KlineLoader?.fetchPage) {
      const prev = KlineLoader.getMarket?.();
      if (KlineLoader.setMarket) KlineLoader.setMarket('futures');
      try {
        return await KlineLoader.fetchPage(symbol, interval, (url) => fetch(url).then((r) => {
          if (!r.ok) throw new Error(`Klines fetch failed (${r.status})`);
          return r.json();
        }), endTimeMs);
      } finally {
        if (prev && KlineLoader.setMarket) KlineLoader.setMarket(prev);
      }
    }

    let url = `${FUTURES_API}/klines?symbol=${symbol}&interval=${interval}&limit=${PAGE_SIZE}`;
    if (endTimeMs != null) url += `&endTime=${endTimeMs}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Klines fetch failed (${res.status})`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Invalid klines response');
    return mapKlines(data);
  }

  async function fetchOlderPages(symbol, interval, candles, pageCount, shouldStop) {
    let merged = candles;
    let pagesFetched = 0;
    let hitEnd = false;
    for (let n = 0; n < pageCount; n++) {
      if (shouldStop?.()) break;
      if (n > 0) await new Promise((r) => setTimeout(r, PAGE_FETCH_DELAY_MS));
      const oldestMs = merged[0].time * 1000 - 1;
      const older = await fetchPage(symbol, interval, oldestMs);
      pagesFetched += 1;
      if (!older.length) {
        hitEnd = true;
        break;
      }
      const next = mergeCandles(merged, older);
      const grew = next.length > merged.length;
      merged = next;
      if (!grew || older.length < PAGE_SIZE / 10) {
        hitEnd = true;
        break;
      }
    }
    return { candles: merged, pagesFetched, hitEnd };
  }

  function tradeProgress(candles, settings, targetTrades) {
    const stats = window.BacktestRunner?.runBacktestProbe
      ? BacktestRunner.runBacktestProbe(candles, settings, targetTrades)
      : FuturesStrategy.backtest(candles, settings, {
        maxTrades: targetTrades,
        skipMarkers: true,
      }).stats;
    if (!stats) return { totalTrades: 0, targetReached: false };
    const totalTrades = stats.totalTrades ?? stats.trades;
    return {
      totalTrades,
      targetReached: stats.targetReached === true || totalTrades >= targetTrades,
    };
  }

  function countTrades(candles, settings, targetTrades) {
    return tradeProgress(candles, settings, targetTrades).totalTrades;
  }

  // 데이터는 항상 "최신(시드의 최신 봉) → 과거" 방향으로만 확장한다.
  // shouldStop이 true를 반환하면 즉시 멈추고 지금까지 받은 캔들을 반환한다
  // (호출한 쪽이 캐시에 보존해 다음 실행이 이어서 로드).
  async function loadForTargetTrades(symbol, interval, settings, targetTrades, onProgress, seedCandles = [], shouldStop = null) {
    let candles = seedCandles.length ? [...seedCandles] : await fetchPage(symbol, interval);
    if (!candles.length) return { candles, exhausted: true, trades: 0 };

    let pagesUsed = seedCandles.length ? Math.max(1, Math.ceil(candles.length / PAGE_SIZE)) : 1;
    let progress = tradeProgress(candles, settings, targetTrades);
    let found = progress.totalTrades;
    let budget = maxPagesForTarget(targetTrades);
    let exhausted = false;
    let noGainRounds = 0;
    const NO_GAIN_LIMIT = 4;
    const MIN_PAGES_BEFORE_NO_GAIN_EXHAUST = 8;

    const report = (loading, extra = {}) => {
      if (!onProgress) return;
      onProgress({
        trades: found,
        target: targetTrades,
        candles: candles.length,
        page: pagesUsed,
        maxPages: exhausted ? pagesUsed : budget,
        loading,
        exhausted,
        ...extra,
      });
    };
    report(true);

    while (!progress.targetReached && pagesUsed < budget && !exhausted) {
      if (shouldStop?.()) break;
      const beforeLen = candles.length;
      const beforeFound = found;
      const remaining = targetTrades - found;
      const barsPerTrade = found > 0
        ? candles.length / found
        : barsPerTradeHint(interval) * 3;
      const neededBars = Math.ceil(remaining * barsPerTrade * 1.35) + PAGE_SIZE;
      const estPagesNeeded = Math.ceil(neededBars / PAGE_SIZE);
      budget = Math.min(HARD_MAX_PAGES, Math.max(budget, pagesUsed + estPagesNeeded));
      const pagesToFetch = Math.max(
        1,
        Math.min(estPagesNeeded, budget - pagesUsed, 10),
      );

      report(true, { phase: 'fetch' });
      const fetched = await fetchOlderPages(symbol, interval, candles, pagesToFetch, shouldStop);
      candles = fetched.candles;
      pagesUsed += Math.max(1, fetched.pagesFetched);

      if (candles.length === beforeLen || fetched.hitEnd) {
        exhausted = true;
        break;
      }

      report(true, { phase: 'compute' });
      progress = tradeProgress(candles, settings, targetTrades);
      found = progress.totalTrades;
      if (progress.targetReached) break;

      if (found <= beforeFound) {
        noGainRounds += 1;
        // Segment backtest can need several past pages before older trades appear.
        if (noGainRounds >= NO_GAIN_LIMIT && pagesUsed >= MIN_PAGES_BEFORE_NO_GAIN_EXHAUST) {
          exhausted = true;
          break;
        }
      } else {
        noGainRounds = 0;
      }
      report(true);
    }

    if (!progress.targetReached && pagesUsed >= budget) {
      exhausted = true;
    }

    report(false);
    return { candles, exhausted, trades: found };
  }

  return { loadForTargetTrades, PAGE_SIZE, maxPagesForTarget, barsPerTradeHint };
})();

window.BacktestLoader = BacktestLoader;
