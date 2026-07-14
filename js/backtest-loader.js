/* Fetch extended kline history until backtest reaches target trade count */
const BacktestLoader = (() => {
  const FUTURES_API = 'https://fapi.binance.com/fapi/v1';
  const PAGE_SIZE = 1000;

  // Hard ceiling on how many 1000-candle pages we will ever pull for a single
  // backtest, to protect against runaway loops and API hammering. This is a
  // safety net — normally we stop as soon as the target trade count is reached
  // or the symbol runs out of history.
  const HARD_MAX_PAGES = 300;

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
    let url = `${FUTURES_API}/klines?symbol=${symbol}&interval=${interval}&limit=${PAGE_SIZE}`;
    if (endTimeMs != null) url += `&endTime=${endTimeMs}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Klines fetch failed (${res.status})`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Invalid klines response');
    return mapKlines(data);
  }

  async function fetchOlderPages(symbol, interval, candles, pageCount) {
    let merged = candles;
    for (let n = 0; n < pageCount; n++) {
      const oldestMs = merged[0].time * 1000 - 1;
      const older = await fetchPage(symbol, interval, oldestMs);
      if (!older.length || older.length < PAGE_SIZE / 10) break;
      const next = mergeCandles(merged, older);
      if (next.length === merged.length) break;
      merged = next;
    }
    return merged;
  }

  function countTrades(candles, settings, targetTrades) {
    const { stats } = FuturesStrategy.backtest(candles, settings, { maxTrades: targetTrades });
    // backtest caps `trades` at targetTrades, so prefer the uncapped total.
    return stats.totalTrades ?? stats.trades;
  }

  // Adaptively pulls older history until the backtest actually produces
  // `targetTrades` trades. Instead of guessing bar counts up front, we measure
  // the real trade density from each pass and load only as much more as needed,
  // stopping when the target is met OR the symbol has no more history OR we hit
  // the hard page ceiling.
  async function loadForTargetTrades(symbol, interval, settings, targetTrades, onProgress, seedCandles = []) {
    const maxPages = maxPagesForTarget(targetTrades);
    let candles = seedCandles.length ? [...seedCandles] : await fetchPage(symbol, interval);
    if (!candles.length) return candles;

    let pagesUsed = seedCandles.length ? Math.max(1, Math.ceil(candles.length / PAGE_SIZE)) : 1;
    let found = countTrades(candles, settings, targetTrades);

    const report = (loading) => {
      if (!onProgress) return;
      onProgress({
        trades: found,
        target: targetTrades,
        candles: candles.length,
        page: pagesUsed,
        maxPages,
        loading,
      });
    };
    report(true);

    while (found < targetTrades && pagesUsed < maxPages) {
      const before = candles.length;
      const remaining = targetTrades - found;
      // Bars needed per trade based on what we've observed so far. Before any
      // trade is seen, fall back to a conservative multiple of the hint.
      const barsPerTrade = found > 0
        ? candles.length / found
        : barsPerTradeHint(interval) * 3;
      const neededBars = Math.ceil(remaining * barsPerTrade * 1.35) + PAGE_SIZE;
      const pagesToFetch = Math.max(
        2,
        Math.min(Math.ceil(neededBars / PAGE_SIZE), maxPages - pagesUsed, 10),
      );

      candles = await fetchOlderPages(symbol, interval, candles, pagesToFetch);
      pagesUsed += pagesToFetch;

      // No new candles came back → the symbol has no more history to load.
      if (candles.length === before) break;

      found = countTrades(candles, settings, targetTrades);
      report(true);
    }

    report(false);
    return candles;
  }

  return { loadForTargetTrades, PAGE_SIZE, maxPagesForTarget, barsPerTradeHint };
})();

window.BacktestLoader = BacktestLoader;
