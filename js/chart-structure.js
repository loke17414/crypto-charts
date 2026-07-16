/**
 * Chart structure analysis — FVG gaps, RSI/MACD divergence, recent candle tape for GPT.
 */
(function () {
  'use strict';

  function round(v, d = 2) {
    if (!Number.isFinite(v)) return null;
    const m = 10 ** d;
    return Math.round(v * m) / m;
  }

  function formatRecentCandles(candles, count = 15) {
    if (!Array.isArray(candles) || !candles.length) return [];
    const slice = candles.slice(-count);
    const start = candles.length - slice.length;
    return slice.map((c, i) => {
      const body = c.close - c.open;
      const range = c.high - c.low;
      const bodyPct = range > 0 ? (body / range) * 100 : 0;
      return {
        idx: start + i,
        offset: i - slice.length + 1,
        time: c.time,
        o: round(c.open),
        h: round(c.high),
        l: round(c.low),
        c: round(c.close),
        v: round(c.volume, 0),
        dir: c.close >= c.open ? 'up' : 'down',
        bodyPct: round(bodyPct, 1),
      };
    });
  }

  function isFvgFilled(zone, candles, fromIndex) {
    for (let j = fromIndex + 1; j < candles.length; j++) {
      const bar = candles[j];
      if (zone.side === 'bullish' && bar.low <= zone.bottom) return true;
      if (zone.side === 'bearish' && bar.high >= zone.top) return true;
    }
    return false;
  }

  function detectFvgZones(candles, lookback = 50) {
    if (!Array.isArray(candles) || candles.length < 3) return [];
    const start = Math.max(2, candles.length - lookback);
    const zones = [];
    for (let i = start; i < candles.length; i++) {
      const c0 = candles[i - 2];
      const c2 = candles[i];
      if (c0.high < c2.low) {
        zones.push({
          side: 'bullish',
          top: c2.low,
          bottom: c0.high,
          mid: (c2.low + c0.high) / 2,
          formedAt: i,
          size: c2.low - c0.high,
        });
      }
      if (c0.low > c2.high) {
        zones.push({
          side: 'bearish',
          top: c0.low,
          bottom: c2.high,
          mid: (c0.low + c2.high) / 2,
          formedAt: i,
          size: c0.low - c2.high,
        });
      }
    }
    return zones.map((z) => ({
      ...z,
      top: round(z.top),
      bottom: round(z.bottom),
      mid: round(z.mid),
      size: round(z.size),
      filled: isFvgFilled(z, candles, z.formedAt),
    }));
  }

  function findPivots(values, kind, left = 2, right = 2) {
    const pivots = [];
    for (let i = left; i < values.length - right; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      let ok = true;
      for (let j = i - left; j <= i + right; j++) {
        if (j === i) continue;
        const other = values[j];
        if (!Number.isFinite(other)) {
          ok = false;
          break;
        }
        if (kind === 'low' ? other <= v : other >= v) {
          ok = false;
          break;
        }
      }
      if (ok) pivots.push({ index: i, value: v });
    }
    return pivots;
  }

  function seriesValues(candles, indicator, period) {
    if (indicator === 'rsi' && window.TA?.rsi) {
      const s = TA.rsi(candles, period || 14);
      return candles.map((_, i) => {
        const pt = s?.[i];
        return pt?.value ?? pt ?? null;
      });
    }
    if (indicator === 'macd' && window.TA?.macd) {
      const m = TA.macd(candles);
      const hist = m?.histogram || m?.hist;
      return candles.map((c) => {
        const pt = hist?.find?.((x) => x.time === c.time);
        return pt?.value ?? pt ?? null;
      });
    }
    return candles.map(() => null);
  }

  function detectDivergence(candles, opts = {}) {
    const indicator = opts.indicator || 'rsi';
    const period = opts.period || 14;
    const lookback = opts.lookback || 40;
    const pivotBars = opts.pivotBars || 2;
    const empty = {
      indicator,
      bullish: false,
      bearish: false,
      detail: null,
      pivots: { priceHighs: [], priceLows: [], indHighs: [], indLows: [] },
    };
    if (!Array.isArray(candles) || candles.length < lookback) return empty;

    const sliceStart = Math.max(0, candles.length - lookback);
    const slice = candles.slice(sliceStart);
    const closes = slice.map((c) => c.close);
    const indFull = seriesValues(candles, indicator, period);
    const indSlice = indFull.slice(sliceStart);

    const priceLows = findPivots(closes, 'low', pivotBars, pivotBars);
    const priceHighs = findPivots(closes, 'high', pivotBars, pivotBars);
    const indLows = findPivots(indSlice, 'low', pivotBars, pivotBars);
    const indHighs = findPivots(indSlice, 'high', pivotBars, pivotBars);

    let bullish = false;
    let bearish = false;
    let detail = null;

    if (priceLows.length >= 2 && indLows.length >= 2) {
      const p1 = priceLows[priceLows.length - 2];
      const p2 = priceLows[priceLows.length - 1];
      const i1 = indLows[indLows.length - 2];
      const i2 = indLows[indLows.length - 1];
      if (p2.value < p1.value && i2.value > i1.value) {
        bullish = true;
        detail = `${indicator.toUpperCase()} bullish divergence: price lower low, ${indicator} higher low`;
      }
    }
    if (priceHighs.length >= 2 && indHighs.length >= 2) {
      const p1 = priceHighs[priceHighs.length - 2];
      const p2 = priceHighs[priceHighs.length - 1];
      const i1 = indHighs[indHighs.length - 2];
      const i2 = indHighs[indHighs.length - 1];
      if (p2.value > p1.value && i2.value < i1.value) {
        bearish = true;
        detail = `${indicator.toUpperCase()} bearish divergence: price higher high, ${indicator} lower high`;
      }
    }

    return {
      indicator,
      bullish,
      bearish,
      detail,
      pivots: {
        priceHighs: priceHighs.slice(-3),
        priceLows: priceLows.slice(-3),
        indHighs: indHighs.slice(-3),
        indLows: indLows.slice(-3),
      },
    };
  }

  function priceInZone(price, zone) {
    return Number.isFinite(price) && price >= zone.bottom && price <= zone.top;
  }

  function activeFvgsAt(candles, index, lookback = 30) {
    const subset = candles.slice(0, index + 1);
    const zones = detectFvgZones(subset, lookback).filter((z) => !z.filled);
    const price = subset[index]?.close;
    return { zones, inZone: zones.filter((z) => priceInZone(price, z)) };
  }

  function evaluateFvg(candles, index, condition) {
    const side = condition.side === 'bearish' ? 'bearish' : 'bullish';
    const state = condition.state || 'present';
    const lookback = Math.max(5, parseInt(condition.lookback, 10) || 30);
    const { zones, inZone } = activeFvgsAt(candles, index, lookback);
    const matching = zones.filter((z) => z.side === side);
    if (state === 'in_zone') return inZone.some((z) => z.side === side);
    if (state === 'filled') {
      const all = detectFvgZones(candles.slice(0, index + 1), lookback)
        .filter((z) => z.side === side);
      return all.length > 0 && all[all.length - 1].filled;
    }
    return matching.length > 0;
  }

  function evaluateDivergence(candles, index, condition) {
    const kind = condition.kind === 'bearish' ? 'bearish' : 'bullish';
    const indicator = condition.indicator === 'macd' ? 'macd' : 'rsi';
    const lookback = Math.max(15, parseInt(condition.lookback, 10) || 40);
    const period = parseInt(condition.period, 10) || 14;
    const subset = candles.slice(0, index + 1);
    const div = detectDivergence(subset, { indicator, period, lookback });
    return kind === 'bullish' ? div.bullish : div.bearish;
  }

  function analyzeForAi(candles, opts = {}) {
    const recentCount = opts.recentCount || 15;
    const fvgLookback = opts.fvgLookback || 30;
    const recent = formatRecentCandles(candles, recentCount);
    const fvgs = detectFvgZones(candles, fvgLookback);
    const openFvgs = fvgs.filter((z) => !z.filled);
    const price = candles.at(-1)?.close;
    const priceInZones = openFvgs.filter((z) => priceInZone(price, z));

    const rsiDiv = detectDivergence(candles, { indicator: 'rsi', lookback: 40 });
    const macdDiv = detectDivergence(candles, { indicator: 'macd', lookback: 40 });

    return {
      recentCandles: recent,
      recentCandlesNote: 'Oldest→newest. offset 0=current bar, -1=previous. Use for last-N-candle analysis.',
      fvg: {
        open: openFvgs.slice(-5),
        priceInZones,
        lastBullish: openFvgs.filter((z) => z.side === 'bullish').at(-1) || null,
        lastBearish: openFvgs.filter((z) => z.side === 'bearish').at(-1) || null,
      },
      divergence: {
        rsi: { bullish: rsiDiv.bullish, bearish: rsiDiv.bearish, detail: rsiDiv.detail },
        macd: { bullish: macdDiv.bullish, bearish: macdDiv.bearish, detail: macdDiv.detail },
      },
    };
  }

  function catalogForAi() {
    return [
      '- fvg (Fair Value Gap) — 3-candle imbalance gap',
      '  { type:"fvg", side:"bullish"|"bearish", state:"present"|"in_zone"|"filled", lookback:30 }',
      '  bullish FVG = gap up (candle[i-2].high < candle[i].low); bearish = gap down',
      '  present = unfilled gap in lookback; in_zone = price inside open gap; filled = last gap was filled',
      '- divergence — price vs RSI/MACD pivot mismatch',
      '  { type:"divergence", kind:"bullish"|"bearish", indicator:"rsi"|"macd", lookback:40, period:14 }',
      '  bullish = price lower low + indicator higher low; bearish = price higher high + indicator lower high',
    ].join('\n');
  }

  const ChartStructure = {
    formatRecentCandles,
    detectFvgZones,
    detectDivergence,
    analyzeForAi,
    evaluateFvg,
    evaluateDivergence,
    catalogForAi,
  };

  window.ChartStructure = ChartStructure;
})();
