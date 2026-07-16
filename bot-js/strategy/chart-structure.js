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

  // --- Swing high/low (confirmed pivots) -----------------------------------
  // A swing point requires pivotBars candles on BOTH sides to be lower (high)
  // or higher (low). A single neighboring candle is NEVER enough, and the
  // most recent pivotBars candles cannot be confirmed swings yet.

  function isPivotHighAt(candles, i, pivotBars) {
    if (i < pivotBars || i >= candles.length - pivotBars) return false;
    const level = candles[i].high;
    for (let j = i - pivotBars; j <= i + pivotBars; j++) {
      if (j !== i && candles[j].high >= level) return false;
    }
    return true;
  }

  function isPivotLowAt(candles, i, pivotBars) {
    if (i < pivotBars || i >= candles.length - pivotBars) return false;
    const level = candles[i].low;
    for (let j = i - pivotBars; j <= i + pivotBars; j++) {
      if (j !== i && candles[j].low <= level) return false;
    }
    return true;
  }

  function detectSwings(candles, opts = {}) {
    const pivotBars = Math.max(2, parseInt(opts.pivotBars, 10) || 5);
    const lookback = Math.max(pivotBars * 3, parseInt(opts.lookback, 10) || 60);
    const maxPoints = opts.maxPoints || 4;
    const empty = { pivotBars, lookback, highs: [], lows: [], lastHigh: null, lastLow: null };
    if (!Array.isArray(candles) || candles.length < pivotBars * 2 + 1) return empty;

    const lastIdx = candles.length - 1;
    const searchEnd = lastIdx - pivotBars;
    const searchStart = Math.max(pivotBars, lastIdx - lookback);
    const highs = [];
    const lows = [];
    for (let i = searchEnd; i >= searchStart; i--) {
      if (highs.length < maxPoints && isPivotHighAt(candles, i, pivotBars)) {
        highs.push({
          price: round(candles[i].high),
          index: i,
          barsAgo: lastIdx - i,
          time: candles[i].time,
        });
      }
      if (lows.length < maxPoints && isPivotLowAt(candles, i, pivotBars)) {
        lows.push({
          price: round(candles[i].low),
          index: i,
          barsAgo: lastIdx - i,
          time: candles[i].time,
        });
      }
      if (highs.length >= maxPoints && lows.length >= maxPoints) break;
    }

    return {
      pivotBars,
      lookback,
      highs,
      lows,
      lastHigh: highs[0] || null,
      lastLow: lows[0] || null,
    };
  }

  // Last confirmed swing levels as of a given bar index (no lookahead:
  // a pivot at i needs bars up to i+pivotBars, so only pivots with
  // index <= asOf - pivotBars count).
  function swingLevelsAsOf(candles, asOf, pivotBars, lookback) {
    const searchEnd = asOf - pivotBars;
    const searchStart = Math.max(pivotBars, asOf - lookback);
    let high = null;
    let low = null;
    for (let i = searchEnd; i >= searchStart; i--) {
      if (high == null && isPivotHighAt(candles, i, pivotBars)) high = candles[i].high;
      if (low == null && isPivotLowAt(candles, i, pivotBars)) low = candles[i].low;
      if (high != null && low != null) break;
    }
    return { high, low };
  }

  function evaluateSwingBreak(candles, index, condition) {
    const side = condition.side === 'short' ? 'short' : 'long';
    const pivotBars = Math.max(2, parseInt(condition.pivotBars, 10) || 5);
    const lookback = Math.max(pivotBars * 3, parseInt(condition.lookback, 10) || 60);
    if (index < pivotBars * 2 + 1) return false;
    const { high, low } = swingLevelsAsOf(candles, index, pivotBars, lookback);
    const closeNow = candles[index]?.close;
    const closePrev = candles[index - 1]?.close;
    if (![closeNow, closePrev].every(Number.isFinite)) return false;
    if (side === 'long') {
      if (!Number.isFinite(high)) return false;
      return closePrev <= high && closeNow > high;
    }
    if (!Number.isFinite(low)) return false;
    return closePrev >= low && closeNow < low;
  }

  function evaluateSwingNear(candles, index, condition) {
    const side = condition.side === 'short' ? 'short' : 'long';
    const pivotBars = Math.max(2, parseInt(condition.pivotBars, 10) || 5);
    const lookback = Math.max(pivotBars * 3, parseInt(condition.lookback, 10) || 60);
    const tolerancePct = Math.max(0.05, parseFloat(condition.tolerancePct) || 0.5);
    if (index < pivotBars * 2 + 1) return false;
    const { high, low } = swingLevelsAsOf(candles, index, pivotBars, lookback);
    const close = candles[index]?.close;
    if (!Number.isFinite(close)) return false;
    const level = side === 'long' ? low : high;
    if (!Number.isFinite(level) || level <= 0) return false;
    return (Math.abs(close - level) / level) * 100 <= tolerancePct;
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
    const swings = detectSwings(candles, {
      pivotBars: opts.swingPivotBars || 5,
      lookback: opts.swingLookback || 60,
    });

    const distPct = (level) => {
      if (!Number.isFinite(price) || !Number.isFinite(level) || !level) return null;
      return round(((price - level) / level) * 100, 2);
    };
    const lastHigh = swings.lastHigh;
    const lastLow = swings.lastLow;

    return {
      recentCandles: recent,
      recentCandlesNote: 'Oldest→newest. offset 0=current bar, -1=previous. Use for last-N-candle analysis. Do NOT treat offset -1 as a swing high/low.',
      swings: {
        pivotBars: swings.pivotBars,
        lookback: swings.lookback,
        note: `CONFIRMED swings only: candle[i] needs ${swings.pivotBars} lower highs (or higher lows) on BOTH left AND right. A single neighbor candle is NEVER enough. Bars with barsAgo < ${swings.pivotBars} cannot be swings yet. IGNORE raw recentHigh/recentLow range max/min — those are NOT swings.`,
        recentHighs: swings.highs,
        recentLows: swings.lows,
        lastSwingHigh: lastHigh,
        lastSwingLow: lastLow,
        priceVsLastHighPct: lastHigh ? distPct(lastHigh.price) : null,
        priceVsLastLowPct: lastLow ? distPct(lastLow.price) : null,
        relation: {
          aboveLastHigh: lastHigh ? price > lastHigh.price : null,
          belowLastLow: lastLow ? price < lastLow.price : null,
          betweenSwings: lastHigh && lastLow
            ? price < lastHigh.price && price > lastLow.price
            : null,
        },
      },
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
      '- swing_break — close breaks the LAST CONFIRMED swing level (pivot needs pivotBars candles on both sides)',
      '  { type:"swing_break", side:"long"|"short", pivotBars:5, lookback:60 }',
      '  long = close crosses above last confirmed swing high; short = close crosses below last confirmed swing low',
      '- swing_near — close within tolerancePct of the last confirmed swing level (support/resistance touch)',
      '  { type:"swing_near", side:"long"|"short", pivotBars:5, lookback:60, tolerancePct:0.5 }',
      '  long = near swing low (support); short = near swing high (resistance)',
    ].join('\n');
  }

  const ChartStructure = {
    formatRecentCandles,
    detectFvgZones,
    detectDivergence,
    detectSwings,
    swingLevelsAsOf,
    analyzeForAi,
    evaluateFvg,
    evaluateDivergence,
    evaluateSwingBreak,
    evaluateSwingNear,
    catalogForAi,
  };

  window.ChartStructure = ChartStructure;
})();
