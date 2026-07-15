/* Paginated Binance kline history loader (spot or USDT-M futures) */
const KlineLoader = (() => {
  const ENDPOINTS = {
    spot: 'https://api.binance.com/api/v3',
    futures: 'https://fapi.binance.com/fapi/v1',
  };

  let market = 'spot';
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 50;

  function setMarket(mode) {
    market = mode === 'futures' ? 'futures' : 'spot';
  }

  function getMarket() {
    return market;
  }

  function apiBase() {
    return ENDPOINTS[market];
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
    const byTime = new Map();
    [...older, ...existing].forEach((c) => byTime.set(c.time, c));
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  async function fetchPage(symbol, interval, fetchJson, endTimeMs = null) {
    let url = `${apiBase()}/klines?symbol=${symbol}&interval=${interval}&limit=${PAGE_SIZE}`;
    if (endTimeMs != null) url += `&endTime=${endTimeMs}`;
    const data = await fetchJson(url);
    if (!Array.isArray(data)) throw new Error('Invalid klines response');
    return mapKlines(data);
  }

  async function fetchHistorical(symbol, interval, targetBars, fetchJson, onProgress) {
    const target = Math.max(PAGE_SIZE, targetBars);
    let candles = await fetchPage(symbol, interval, fetchJson);
    if (onProgress) onProgress({ candles: candles.length, target, page: 1 });
    if (candles.length >= target) return candles.slice(-target);

    const maxPages = Math.min(MAX_PAGES, Math.ceil(target / PAGE_SIZE) + 1);
    for (let page = 1; page < maxPages; page++) {
      const oldestMs = candles[0].time * 1000 - 1;
      const older = await fetchPage(symbol, interval, fetchJson, oldestMs);
      if (!older.length) break;

      const merged = mergeCandles(candles, older);
      if (merged.length === candles.length) break;
      candles = merged;

      if (onProgress) {
        onProgress({ candles: candles.length, target, page: page + 1 });
      }

      if (candles.length >= target) return candles.slice(-target);
      if (older.length < PAGE_SIZE / 2) break;
    }

    return candles;
  }

  async function fetchOlder(symbol, interval, beforeTimeSec, fetchJson) {
    const endTimeMs = beforeTimeSec * 1000 - 1;
    return fetchPage(symbol, interval, fetchJson, endTimeMs);
  }

  return {
    setMarket,
    getMarket,
    fetchHistorical,
    fetchOlder,
    fetchPage,
    mergeCandles,
    mapKlines,
    PAGE_SIZE,
    MAX_PAGES,
  };
})();

window.KlineLoader = KlineLoader;
