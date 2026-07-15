/* Fetch extended USDT-M futures kline history until backtest reaches target trade count */
const BacktestLoader = (() => {
  const FUTURES_API = 'https://fapi.binance.com/fapi/v1';
  const PAGE_SIZE = 1000;
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

  async function fetchOlderPages(symbol, interval, candles, pageCount) {
    let merged = candles;
    for (let n = 0; n < pageCount; n++) {
      const oldestMs = merged[0].time * 1000 - 1;
      const older = await fetchPage(symbol, interval, oldestMs);
      if (!older.length) break;
      // 짧은 페이지(히스토리 끝)도 병합한 뒤에 멈춘다 — 버리면 가장 오래된
      // 구간이 유실되어 목표 횟수를 못 채운다.
      const next = mergeCandles(merged, older);
      const grew = next.length > merged.length;
      merged = next;
      if (!grew || older.length < PAGE_SIZE / 10) break;
    }
    return merged;
  }

  function countTrades(candles, settings, targetTrades) {
    const { stats } = FuturesStrategy.backtest(candles, settings, { maxTrades: targetTrades });
    return stats.totalTrades ?? stats.trades;
  }

  async function loadForTargetTrades(symbol, interval, settings, targetTrades, onProgress, seedCandles = []) {
    const maxPages = maxPagesForTarget(targetTrades);
    let candles = seedCandles.length ? [...seedCandles] : await fetchPage(symbol, interval);
    if (!candles.length) return candles;

    // 페이지 예산은 "이번 실행에서 새로 받아오는 양"만 계산한다. 시드(차트에
    // 이미 있던 캔들)를 예산에서 차감하면 시드가 클수록 로딩이 일찍 끊겨
    // 목표 횟수를 못 채우는 부분 결과가 만들어졌다.
    let pagesUsed = seedCandles.length ? 0 : 1;
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
