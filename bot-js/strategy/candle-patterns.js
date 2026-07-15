/* Candle metrics & pattern detection for strategy rules */
const CandlePatterns = (() => {
  const PATTERN_LABELS = {
    bullish: '양봉',
    bearish: '음봉',
    doji: '도지',
    hammer: '해머',
    inverted_hammer: '역해머',
    shooting_star: '슈팅스타',
    engulfing_bull: '상승 장악',
    engulfing_bear: '하락 장악',
    marubozu_bull: '양봉 마루보즈',
    marubozu_bear: '음봉 마루보즈',
    pin_bar_bull: '핀바(롱)',
    pin_bar_bear: '핀바(숏)',
    inside_bar: '인사이드바',
    outside_bar: '아웃사이드바',
    three_white_soldiers: '적삼병',
    three_black_crows: '흑삼병',
  };

  const METRIC_LABELS = {
    body: '몸통',
    range: '전체 범위',
    body_pct: '몸통비율',
    upper_wick: '윗꼬리',
    lower_wick: '아랫꼬리',
    upper_wick_pct: '윗꼬리비율',
    lower_wick_pct: '아랫꼬리비율',
    change_pct: '전봉대비변화%',
    is_bullish: '양봉(1/0)',
    is_bearish: '음봉(1/0)',
  };

  function candleAt(candles, index) {
    if (!candles?.length || index < 0 || index >= candles.length) return null;
    return candles[index];
  }

  function parts(candle) {
    if (!candle) return null;
    const { open, high, low, close } = candle;
    const body = Math.abs(close - open);
    const range = Math.max(high - low, 1e-12);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const bullish = close > open;
    const bearish = close < open;
    return {
      open,
      high,
      low,
      close,
      body,
      range,
      upperWick,
      lowerWick,
      bodyPct: body / range,
      upperWickPct: upperWick / range,
      lowerWickPct: lowerWick / range,
      bullish,
      bearish,
    };
  }

  function changePct(candles, index) {
    const cur = candleAt(candles, index);
    const prev = candleAt(candles, index - 1);
    if (!cur || !prev || !prev.close) return null;
    return ((cur.close - prev.close) / prev.close) * 100;
  }

  function metric(candles, index, name) {
    const p = parts(candleAt(candles, index));
    if (!p) return null;
    switch (name) {
      case 'body': return p.body;
      case 'range': return p.range;
      case 'body_pct': return p.bodyPct * 100;
      case 'upper_wick': return p.upperWick;
      case 'lower_wick': return p.lowerWick;
      case 'upper_wick_pct': return p.upperWickPct * 100;
      case 'lower_wick_pct': return p.lowerWickPct * 100;
      case 'change_pct': return changePct(candles, index);
      case 'is_bullish': return p.bullish ? 1 : 0;
      case 'is_bearish': return p.bearish ? 1 : 0;
      default: return null;
    }
  }

  function isDoji(p, maxBodyPct = 0.1) {
    return p.bodyPct <= maxBodyPct;
  }

  function isHammer(p, minLowerRatio = 2, maxUpperRatio = 0.5) {
    if (!p.bullish && !p.bearish) return false;
    return p.lowerWick >= p.body * minLowerRatio && p.upperWick <= p.body * maxUpperRatio;
  }

  function isShootingStar(p, minUpperRatio = 2, maxLowerRatio = 0.5) {
    return p.upperWick >= p.body * minUpperRatio && p.lowerWick <= p.body * maxLowerRatio;
  }

  function isEngulfingBull(prev, cur) {
    const a = parts(prev);
    const b = parts(cur);
    if (!a || !b) return false;
    return a.bearish && b.bullish && b.open <= a.close && b.close >= a.open && b.body > a.body;
  }

  function isEngulfingBear(prev, cur) {
    const a = parts(prev);
    const b = parts(cur);
    if (!a || !b) return false;
    return a.bullish && b.bearish && b.open >= a.close && b.close <= a.open && b.body > a.body;
  }

  function isMarubozu(p, bullish, maxWickPct = 0.05) {
    if (bullish && !p.bullish) return false;
    if (!bullish && !p.bearish) return false;
    return p.upperWickPct <= maxWickPct && p.lowerWickPct <= maxWickPct;
  }

  function isPinBar(p, bullish) {
    if (bullish) return p.lowerWickPct >= 0.6 && p.bodyPct <= 0.25;
    return p.upperWickPct >= 0.6 && p.bodyPct <= 0.25;
  }

  function isInsideBar(prev, cur) {
    const a = candleAt([prev], 0);
    const b = candleAt([cur], 0);
    if (!a || !b) return false;
    return b.high <= a.high && b.low >= a.low;
  }

  function isOutsideBar(prev, cur) {
    const a = candleAt([prev], 0);
    const b = candleAt([cur], 0);
    if (!a || !b) return false;
    return b.high > a.high && b.low < a.low;
  }

  function isThreeWhiteSoldiers(candles, index) {
    for (let i = index - 2; i <= index; i++) {
      const p = parts(candleAt(candles, i));
      if (!p?.bullish) return false;
      if (i > index - 2 && candleAt(candles, i).close <= candleAt(candles, i - 1).close) return false;
    }
    return true;
  }

  function isThreeBlackCrows(candles, index) {
    for (let i = index - 2; i <= index; i++) {
      const p = parts(candleAt(candles, i));
      if (!p?.bearish) return false;
      if (i > index - 2 && candleAt(candles, i).close >= candleAt(candles, i - 1).close) return false;
    }
    return true;
  }

  function match(candles, index, pattern, params = {}) {
    const cur = candleAt(candles, index);
    const prev = candleAt(candles, index - 1);
    const p = parts(cur);
    if (!p) return false;

    switch (pattern) {
      case 'bullish': return p.bullish;
      case 'bearish': return p.bearish;
      case 'doji': return isDoji(p, params.maxBodyPct ?? 0.1);
      case 'hammer': return isHammer(p, params.minLowerRatio ?? 2, params.maxUpperRatio ?? 0.5);
      case 'inverted_hammer': return p.bullish && isShootingStar(p, params.minUpperRatio ?? 2, params.maxLowerRatio ?? 0.5);
      case 'shooting_star': return isShootingStar(p, params.minUpperRatio ?? 2, params.maxLowerRatio ?? 0.5);
      case 'engulfing_bull': return prev && isEngulfingBull(prev, cur);
      case 'engulfing_bear': return prev && isEngulfingBear(prev, cur);
      case 'marubozu_bull': return isMarubozu(p, true, params.maxWickPct ?? 0.05);
      case 'marubozu_bear': return isMarubozu(p, false, params.maxWickPct ?? 0.05);
      case 'pin_bar_bull': return isPinBar(p, true);
      case 'pin_bar_bear': return isPinBar(p, false);
      case 'inside_bar': return prev && isInsideBar(prev, cur);
      case 'outside_bar': return prev && isOutsideBar(prev, cur);
      case 'three_white_soldiers': return index >= 2 && isThreeWhiteSoldiers(candles, index);
      case 'three_black_crows': return index >= 2 && isThreeBlackCrows(candles, index);
      default: return false;
    }
  }

  function patternLabel(pattern) {
    return PATTERN_LABELS[pattern] || pattern;
  }

  function metricLabel(metricName) {
    return METRIC_LABELS[metricName] || metricName;
  }

  function catalogForAi() {
    return [
      'Candle patterns (type: "candle_pattern", pattern: "<name>", offset: 0=current bar):',
      `- ${Object.entries(PATTERN_LABELS).map(([k, v]) => `${k} (${v})`).join(', ')}`,
      'Candle metrics (source: "candle", metric: "<name>", offset optional):',
      `- ${Object.entries(METRIC_LABELS).map(([k, v]) => `${k} (${v})`).join(', ')}`,
      'Price with bar offset: { source:"price", field:"close|open|high|low|volume", offset:0 } (offset 1 = previous candle)',
      'Example compare: current body_pct > 60 → { type:"compare", left:{source:"candle",metric:"body_pct",offset:0}, op:">", right:{source:"value",value:60} }',
      'Example pattern: engulfing bull → { type:"candle_pattern", pattern:"engulfing_bull", offset:0 }',
    ].join('\n');
  }

  function minBarsForPattern(pattern) {
    if (pattern === 'three_white_soldiers' || pattern === 'three_black_crows') return 3;
    if (['engulfing_bull', 'engulfing_bear', 'inside_bar', 'outside_bar'].includes(pattern)) return 2;
    return 1;
  }

  return {
    metric,
    match,
    patternLabel,
    metricLabel,
    catalogForAi,
    minBarsForPattern,
    parts,
  };
})();

window.CandlePatterns = CandlePatterns;
