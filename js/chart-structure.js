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

  function wickShapeHint(bodyPct, upperWickPct, lowerWickPct) {
    if (lowerWickPct >= 60 && bodyPct <= 25) return 'long_lower_wick';
    if (upperWickPct >= 60 && bodyPct <= 25) return 'long_upper_wick';
    if (bodyPct >= 70) return 'full_body';
    if (upperWickPct >= 40 && lowerWickPct < 20) return 'upper_rejection';
    if (lowerWickPct >= 40 && upperWickPct < 20) return 'lower_rejection';
    return 'balanced';
  }

  const REVERSAL_PATTERN_NAMES = [
    'engulfing_bull', 'engulfing_bear',
    'hammer', 'inverted_hammer', 'shooting_star',
    'pin_bar_bull', 'pin_bar_bear',
    'doji', 'outside_bar',
    'marubozu_bull', 'marubozu_bear',
  ];
  const BULL_REVERSAL_PATTERNS = new Set([
    'engulfing_bull', 'hammer', 'pin_bar_bull', 'marubozu_bull',
  ]);
  const BEAR_REVERSAL_PATTERNS = new Set([
    'engulfing_bear', 'shooting_star', 'pin_bar_bear', 'marubozu_bear', 'inverted_hammer',
  ]);

  function detectPatternsAt(candles, index) {
    if (!Array.isArray(candles) || index < 0 || index >= candles.length) return [];
    if (window.CandlePatterns?.match) {
      return REVERSAL_PATTERN_NAMES.filter((name) => CandlePatterns.match(candles, index, name));
    }
    // Lightweight fallback when CandlePatterns is unavailable
    const cur = candles[index];
    const prev = candles[index - 1];
    if (!cur) return [];
    const range = Math.max(cur.high - cur.low, 1e-12);
    const body = Math.abs(cur.close - cur.open);
    const upper = cur.high - Math.max(cur.open, cur.close);
    const lower = Math.min(cur.open, cur.close) - cur.low;
    const bodyPct = body / range;
    const upperPct = upper / range;
    const lowerPct = lower / range;
    const out = [];
    if (cur.close > cur.open) out.push('bullish');
    if (cur.close < cur.open) out.push('bearish');
    if (bodyPct <= 0.1) out.push('doji');
    if (lowerPct >= 0.6 && bodyPct <= 0.25) out.push('pin_bar_bull');
    if (upperPct >= 0.6 && bodyPct <= 0.25) out.push('pin_bar_bear');
    if (lower >= body * 2 && upper <= body * 0.5) out.push('hammer');
    if (upper >= body * 2 && lower <= body * 0.5) out.push('shooting_star');
    if (prev) {
      const pb = Math.abs(prev.close - prev.open);
      if (prev.close < prev.open && cur.close > cur.open
        && cur.open <= prev.close && cur.close >= prev.open && body > pb) {
        out.push('engulfing_bull');
      }
      if (prev.close > prev.open && cur.close < cur.open
        && cur.open >= prev.close && cur.close <= prev.open && body > pb) {
        out.push('engulfing_bear');
      }
    }
    return out;
  }

  function formatRecentCandles(candles, count = 15) {
    if (!Array.isArray(candles) || !candles.length) return [];
    const slice = candles.slice(-count);
    const start = candles.length - slice.length;
    return slice.map((c, i) => {
      const idx = start + i;
      const range = Math.max(c.high - c.low, 0);
      const bodyAbs = Math.abs(c.close - c.open);
      const upperWick = c.high - Math.max(c.open, c.close);
      const lowerWick = Math.min(c.open, c.close) - c.low;
      const bodyPct = range > 0 ? (bodyAbs / range) * 100 : 0;
      const upperWickPct = range > 0 ? (upperWick / range) * 100 : 0;
      const lowerWickPct = range > 0 ? (lowerWick / range) * 100 : 0;
      const patterns = detectPatternsAt(candles, idx);
      return {
        idx,
        offset: i - slice.length + 1,
        time: c.time,
        o: round(c.open),
        h: round(c.high),
        l: round(c.low),
        c: round(c.close),
        v: round(c.volume, 0),
        dir: c.close >= c.open ? 'up' : 'down',
        // Fractions of (high-low). bodyPct + upperWickPct + lowerWickPct ≈ 100.
        bodyPct: round(bodyPct, 1),
        upperWickPct: round(upperWickPct, 1),
        lowerWickPct: round(lowerWickPct, 1),
        shape: wickShapeHint(bodyPct, upperWickPct, lowerWickPct),
        patterns,
      };
    });
  }

  function priorBiasFromTrend(trend) {
    if (!trend) return 'sideways';
    if (trend.structure === 'uptrend') return 'bullish';
    if (trend.structure === 'downtrend') return 'bearish';
    if (trend.maAlignment === 'bullish_stack') return 'bullish';
    if (trend.maAlignment === 'bearish_stack') return 'bearish';
    return trend.direction || 'sideways';
  }

  function nearLevelPct(price, level, tolPct = 0.6) {
    if (![price, level].every(Number.isFinite) || !level) return false;
    return (Math.abs(price - level) / level) * 100 <= tolPct;
  }

  function analyzeTrendReversal(candles, trend, swings, recentCandles) {
    const empty = {
      priorBias: 'sideways',
      phase: 'unclear',
      signals: [],
      latest: null,
      note: 'Trend-reversal needs prior bias + against-trend candle (engulfing/hammer/shooting/pin) ideally at swing extreme, or CHOCH (close breaks last swing against prior trend).',
    };
    if (!Array.isArray(candles) || candles.length < 5) return empty;

    const priorBias = priorBiasFromTrend(trend);
    const lastHigh = swings?.lastSwingHigh || swings?.lastHigh || null;
    const lastLow = swings?.lastSwingLow || swings?.lastLow || null;
    const highPx = lastHigh?.price ?? null;
    const lowPx = lastLow?.price ?? null;
    const lastIdx = candles.length - 1;
    const last = candles[lastIdx];
    const prev = candles[lastIdx - 1];
    const tape = Array.isArray(recentCandles) ? recentCandles : formatRecentCandles(candles, 8);
    const signals = [];

    // CHOCH / structure break against prior bias (stronger than a single reversal candle)
    if (priorBias === 'bullish' && Number.isFinite(lowPx) && prev && last
      && prev.close >= lowPx && last.close < lowPx) {
      signals.push({
        side: 'bearish',
        kind: 'choch_below_swing_low',
        strength: 'strong',
        offset: 0,
        level: round(lowPx),
        patterns: tape.at(-1)?.patterns || detectPatternsAt(candles, lastIdx),
        reason: '상승 추세 중 전저점(lastSwingLow) 종가 이탈 → 구조 전환(CHOCH)',
      });
    }
    if (priorBias === 'bearish' && Number.isFinite(highPx) && prev && last
      && prev.close <= highPx && last.close > highPx) {
      signals.push({
        side: 'bullish',
        kind: 'choch_above_swing_high',
        strength: 'strong',
        offset: 0,
        level: round(highPx),
        patterns: tape.at(-1)?.patterns || detectPatternsAt(candles, lastIdx),
        reason: '하락 추세 중 전고점(lastSwingHigh) 종가 돌파 → 구조 전환(CHOCH)',
      });
    }

    // Scan recent bars for against-trend reversal candles
    const scan = tape.slice(-5);
    for (const bar of scan) {
      const pats = bar.patterns || [];
      const bullPat = pats.some((p) => BULL_REVERSAL_PATTERNS.has(p))
        || bar.shape === 'long_lower_wick' || bar.shape === 'lower_rejection';
      const bearPat = pats.some((p) => BEAR_REVERSAL_PATTERNS.has(p))
        || bar.shape === 'long_upper_wick' || bar.shape === 'upper_rejection';
      const atLow = nearLevelPct(bar.l, lowPx) || nearLevelPct(bar.c, lowPx);
      const atHigh = nearLevelPct(bar.h, highPx) || nearLevelPct(bar.c, highPx);

      if (priorBias === 'bearish' && bullPat) {
        signals.push({
          side: 'bullish',
          kind: atLow ? 'reversal_candle_at_swing_low' : 'reversal_candle_against_downtrend',
          strength: atLow ? 'medium' : 'weak',
          offset: bar.offset,
          patterns: pats,
          shape: bar.shape,
          reason: atLow
            ? '하락 추세 + 전저점 근처 상승 전환 캔들(해머/장악/아랫꼬리)'
            : '하락 추세에 역행하는 상승 전환 캔들 (스윙 저점 미확인)',
        });
      }
      if (priorBias === 'bullish' && bearPat) {
        signals.push({
          side: 'bearish',
          kind: atHigh ? 'reversal_candle_at_swing_high' : 'reversal_candle_against_uptrend',
          strength: atHigh ? 'medium' : 'weak',
          offset: bar.offset,
          patterns: pats,
          shape: bar.shape,
          reason: atHigh
            ? '상승 추세 + 전고점 근처 하락 전환 캔들(슈팅스타/장악/윗꼬리)'
            : '상승 추세에 역행하는 하락 전환 캔들 (스윙 고점 미확인)',
        });
      }
    }

    // Deduplicate by side+kind+offset
    const seen = new Set();
    const unique = [];
    for (const s of signals) {
      const key = `${s.side}|${s.kind}|${s.offset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(s);
    }

    const hasStrong = unique.some((s) => s.strength === 'strong');
    const hasMedium = unique.some((s) => s.strength === 'medium');
    let phase = 'continuation';
    if (priorBias === 'sideways' && !unique.length) phase = 'unclear';
    else if (hasStrong) phase = 'structure_break';
    else if (hasMedium) phase = 'potential_reversal';
    else if (unique.length) phase = 'early_warning';

    const latestBar = tape.at(-1) || null;
    const latestPats = latestBar?.patterns || detectPatternsAt(candles, lastIdx);
    const againstTrend = priorBias === 'bullish'
      ? latestPats.some((p) => BEAR_REVERSAL_PATTERNS.has(p)) || latestBar?.shape === 'long_upper_wick'
      : priorBias === 'bearish'
        ? latestPats.some((p) => BULL_REVERSAL_PATTERNS.has(p)) || latestBar?.shape === 'long_lower_wick'
        : false;

    return {
      priorBias,
      phase,
      signals: unique.slice(0, 6),
      latest: latestBar ? {
        offset: 0,
        dir: latestBar.dir,
        shape: latestBar.shape,
        patterns: latestPats,
        againstTrend,
        bodyPct: latestBar.bodyPct,
        upperWickPct: latestBar.upperWickPct,
        lowerWickPct: latestBar.lowerWickPct,
      } : null,
      swingContext: {
        lastSwingHigh: lastHigh,
        lastSwingLow: lastLow,
        nearSwingHigh: nearLevelPct(last?.high, highPx) || nearLevelPct(last?.close, highPx),
        nearSwingLow: nearLevelPct(last?.low, lowPx) || nearLevelPct(last?.close, lowPx),
      },
      note: 'phase: continuation|early_warning|potential_reversal|structure_break|unclear. '
        + '추세전환 캔들 = priorBias에 역행하는 engulfing/hammer/shooting/pin (이상적으로 스윙 고·저점 근처). '
        + '구조 전환(CHOCH) = 상승중 전저점 종가 이탈 또는 하락중 전고점 종가 돌파. '
        + 'Trust this block for 추세전환 — do not invent from dir alone.',
    };
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

  function precomputeSwingLevels(candles, pivotBars, lookback) {
    const n = candles.length;
    const highs = new Array(n);
    const lows = new Array(n);
    const pivotHighIdx = [];
    const pivotLowIdx = [];
    for (let i = pivotBars; i < n - pivotBars; i++) {
      if (isPivotHighAt(candles, i, pivotBars)) pivotHighIdx.push(i);
      if (isPivotLowAt(candles, i, pivotBars)) pivotLowIdx.push(i);
    }
    let hiPi = 0;
    let loPi = 0;
    for (let i = 0; i < n; i++) {
      if (i < pivotBars * 2 + 1) {
        highs[i] = lows[i] = null;
        continue;
      }
      const searchEnd = i - pivotBars;
      const searchStart = Math.max(pivotBars, i - lookback);
      while (hiPi < pivotHighIdx.length && pivotHighIdx[hiPi] <= searchEnd) hiPi += 1;
      while (loPi < pivotLowIdx.length && pivotLowIdx[loPi] <= searchEnd) loPi += 1;
      let high = null;
      let low = null;
      if (hiPi > 0) {
        const idx = pivotHighIdx[hiPi - 1];
        if (idx >= searchStart) high = candles[idx].high;
      }
      if (loPi > 0) {
        const idx = pivotLowIdx[loPi - 1];
        if (idx >= searchStart) low = candles[idx].low;
      }
      highs[i] = high;
      lows[i] = low;
    }
    return { highs, lows };
  }

  function buildFvgZoneIndex(candles) {
    const n = candles.length;
    const zones = [];
    for (let i = 2; i < n; i++) {
      const c0 = candles[i - 2];
      const c2 = candles[i];
      if (c0.high < c2.low) {
        zones.push({
          side: 'bullish',
          top: c2.low,
          bottom: c0.high,
          formedAt: i,
          filledAt: n,
        });
      }
      if (c0.low > c2.high) {
        zones.push({
          side: 'bearish',
          top: c0.low,
          bottom: c2.high,
          formedAt: i,
          filledAt: n,
        });
      }
    }
    for (const zone of zones) {
      for (let j = zone.formedAt + 1; j < n; j++) {
        const bar = candles[j];
        if (zone.side === 'bullish' && bar.low <= zone.bottom) {
          zone.filledAt = j;
          break;
        }
        if (zone.side === 'bearish' && bar.high >= zone.top) {
          zone.filledAt = j;
          break;
        }
      }
    }
    return zones;
  }

  function queryFvgAt(fvgCache, candles, index, side, state, lookback) {
    const minForm = Math.max(2, index - lookback + 1);
    const price = candles[index]?.close;
    const inWindow = fvgCache.zones.filter(
      (z) => z.side === side && z.formedAt >= minForm && z.formedAt <= index,
    );
    if (state === 'filled') {
      return inWindow.length > 0 && inWindow[inWindow.length - 1].filledAt <= index;
    }
    const open = inWindow.filter((z) => z.filledAt > index);
    if (state === 'in_zone') {
      return open.some((z) => priceInZone(price, z));
    }
    return open.length > 0;
  }

  function precomputeDivergenceSeries(candles, indicator, period, lookback) {
    const n = candles.length;
    const bullish = new Array(n).fill(false);
    const bearish = new Array(n).fill(false);
    const start = Math.max(lookback + period, 20);
    for (let i = start; i < n; i++) {
      const sliceStart = Math.max(0, i + 1 - lookback);
      const div = detectDivergence(candles.slice(sliceStart, i + 1), { indicator, period, lookback });
      bullish[i] = div.bullish;
      bearish[i] = div.bearish;
    }
    return { bullish, bearish };
  }

  function buildBacktestStructureCache(candles, conditions) {
    const cache = { swing: {}, fvg: null, divergence: {} };
    if (!Array.isArray(conditions) || !conditions.length) return cache;

    for (const cond of conditions) {
      if (!cond || typeof cond !== 'object') continue;
      if (cond.type === 'swing_break' || cond.type === 'swing_near') {
        const pivotBars = Math.max(2, parseInt(cond.pivotBars, 10) || 5);
        const lookback = Math.max(pivotBars * 3, parseInt(cond.lookback, 10) || 60);
        const key = `${pivotBars}:${lookback}`;
        if (!cache.swing[key]) {
          cache.swing[key] = precomputeSwingLevels(candles, pivotBars, lookback);
        }
      }
      if (cond.type === 'fvg' && !cache.fvg) {
        cache.fvg = { zones: buildFvgZoneIndex(candles) };
      }
      if (cond.type === 'divergence') {
        const indicator = cond.indicator === 'macd' ? 'macd' : 'rsi';
        const lookback = Math.max(15, parseInt(cond.lookback, 10) || 40);
        const period = parseInt(cond.period, 10) || 14;
        const key = `${indicator}:${period}:${lookback}`;
        if (!cache.divergence[key]) {
          cache.divergence[key] = precomputeDivergenceSeries(candles, indicator, period, lookback);
        }
      }
    }
    return cache;
  }

  function analyzeTrend(candles, opts = {}) {
    const price = candles.at(-1)?.close;
    const empty = {
      direction: 'sideways',
      structure: 'range',
      maAlignment: null,
      adx14: null,
      ema7: null,
      ema25: null,
      ema99: null,
      priceAboveEma7: null,
      priceAboveEma25: null,
      priceAboveEma99: null,
    };
    if (!Array.isArray(candles) || candles.length < 30 || !Number.isFinite(price)) return empty;

    const emaVal = (period) => {
      if (!window.TA?.emaLine) return null;
      const pt = TA.emaLine(candles, period)?.at(-1);
      return pt?.value ?? pt ?? null;
    };
    const ema7 = emaVal(7);
    const ema25 = emaVal(25);
    const ema99 = emaVal(99);

    let adx14 = null;
    if (window.TA?.adx) {
      const pt = TA.adx(candles, 14)?.at(-1);
      adx14 = pt?.value ?? pt ?? null;
    }

    const swings = detectSwings(candles, {
      pivotBars: opts.pivotBars || 5,
      lookback: opts.lookback || 60,
    });
    let structure = 'range';
    if (swings.highs.length >= 2 && swings.lows.length >= 2) {
      const hh = swings.highs[0].price > swings.highs[1].price;
      const hl = swings.lows[0].price > swings.lows[1].price;
      const lh = swings.highs[0].price < swings.highs[1].price;
      const ll = swings.lows[0].price < swings.lows[1].price;
      if (hh && hl) structure = 'uptrend';
      else if (lh && ll) structure = 'downtrend';
    }

    let maAlignment = 'mixed';
    if ([ema7, ema25, ema99].every(Number.isFinite)) {
      if (ema7 > ema25 && ema25 > ema99) maAlignment = 'bullish_stack';
      else if (ema7 < ema25 && ema25 < ema99) maAlignment = 'bearish_stack';
    }

    let direction = 'sideways';
    if (structure === 'uptrend' || maAlignment === 'bullish_stack') direction = 'bullish';
    else if (structure === 'downtrend' || maAlignment === 'bearish_stack') direction = 'bearish';
    if (Number.isFinite(adx14) && adx14 < 18) direction = 'sideways';

    return {
      direction,
      structure,
      maAlignment,
      adx14: adx14 != null ? round(adx14, 1) : null,
      ema7: ema7 != null ? round(ema7, 2) : null,
      ema25: ema25 != null ? round(ema25, 2) : null,
      ema99: ema99 != null ? round(ema99, 2) : null,
      priceAboveEma7: ema7 != null ? price > ema7 : null,
      priceAboveEma25: ema25 != null ? price > ema25 : null,
      priceAboveEma99: ema99 != null ? price > ema99 : null,
      note: 'direction=overall bias; structure=HH/HL swing pattern; maAlignment=EMA7/25/99 stack; adx14<18=trend weak/ranging',
    };
  }

  function evaluateSwingBreak(candles, index, condition, structureCache) {
    const side = condition.side === 'short' ? 'short' : 'long';
    const pivotBars = Math.max(2, parseInt(condition.pivotBars, 10) || 5);
    const lookback = Math.max(pivotBars * 3, parseInt(condition.lookback, 10) || 60);
    if (index < pivotBars * 2 + 1) return false;
    const key = `${pivotBars}:${lookback}`;
    const pre = structureCache?.swing?.[key];
    const high = pre ? pre.highs[index] : swingLevelsAsOf(candles, index, pivotBars, lookback).high;
    const low = pre ? pre.lows[index] : swingLevelsAsOf(candles, index, pivotBars, lookback).low;
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

  function evaluateSwingNear(candles, index, condition, structureCache) {
    const side = condition.side === 'short' ? 'short' : 'long';
    const pivotBars = Math.max(2, parseInt(condition.pivotBars, 10) || 5);
    const lookback = Math.max(pivotBars * 3, parseInt(condition.lookback, 10) || 60);
    const tolerancePct = Math.max(0.05, parseFloat(condition.tolerancePct) || 0.5);
    if (index < pivotBars * 2 + 1) return false;
    const key = `${pivotBars}:${lookback}`;
    const pre = structureCache?.swing?.[key];
    const high = pre ? pre.highs[index] : swingLevelsAsOf(candles, index, pivotBars, lookback).high;
    const low = pre ? pre.lows[index] : swingLevelsAsOf(candles, index, pivotBars, lookback).low;
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

  function evaluateFvg(candles, index, condition, structureCache) {
    const side = condition.side === 'bearish' ? 'bearish' : 'bullish';
    const state = condition.state || 'present';
    const lookback = Math.max(5, parseInt(condition.lookback, 10) || 30);
    if (structureCache?.fvg) {
      return queryFvgAt(structureCache.fvg, candles, index, side, state, lookback);
    }
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

  function evaluateDivergence(candles, index, condition, structureCache) {
    const kind = condition.kind === 'bearish' ? 'bearish' : 'bullish';
    const indicator = condition.indicator === 'macd' ? 'macd' : 'rsi';
    const lookback = Math.max(15, parseInt(condition.lookback, 10) || 40);
    const period = parseInt(condition.period, 10) || 14;
    const key = `${indicator}:${period}:${lookback}`;
    const pre = structureCache?.divergence?.[key];
    if (pre) return kind === 'bullish' ? pre.bullish[index] : pre.bearish[index];
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
    const trend = analyzeTrend(candles, {
      pivotBars: opts.swingPivotBars || 5,
      lookback: opts.swingLookback || 60,
    });
    const swingPack = {
      lastSwingHigh: lastHigh,
      lastSwingLow: lastLow,
      lastHigh,
      lastLow,
    };
    const trendReversal = analyzeTrendReversal(candles, trend, swingPack, recent);

    return {
      recentCandles: recent,
      recentCandlesNote: 'Oldest→newest. offset 0=current bar, -1=previous. bodyPct/upperWickPct/lowerWickPct are % of (high-low) and sum≈100. shape=long_lower_wick|long_upper_wick|upper_rejection|lower_rejection|full_body|balanced. patterns=matched candle patterns. Do NOT treat offset -1 as a swing high/low.',
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
      trend,
      trendReversal,
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
    analyzeTrend,
    analyzeTrendReversal,
    buildBacktestStructureCache,
    analyzeForAi,
    evaluateFvg,
    evaluateDivergence,
    evaluateSwingBreak,
    evaluateSwingNear,
    catalogForAi,
  };

  window.ChartStructure = ChartStructure;
})();
