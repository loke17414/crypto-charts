/* Swing high / low (pivot) level detection */
const SwingLevels = (() => {
  function isPivotHigh(highs, index, pivotBars) {
    if (index < pivotBars || index >= highs.length - pivotBars) return false;
    const level = highs[index];
    for (let j = index - pivotBars; j <= index + pivotBars; j++) {
      if (j !== index && highs[j] >= level) return false;
    }
    return true;
  }

  function isPivotLow(lows, index, pivotBars) {
    if (index < pivotBars || index >= lows.length - pivotBars) return false;
    const level = lows[index];
    for (let j = index - pivotBars; j <= index + pivotBars; j++) {
      if (j !== index && lows[j] <= level) return false;
    }
    return true;
  }

  function recentSwingLevels(highs, lows, endIndex, { pivotBars, lookback }) {
    const start = Math.max(pivotBars, endIndex - lookback);
    const searchEnd = endIndex - pivotBars;
    if (searchEnd < start) {
      return { swingHigh: null, swingLow: null, swingHighIndex: null, swingLowIndex: null };
    }

    let swingHigh = null;
    let swingLow = null;
    let swingHighIndex = null;
    let swingLowIndex = null;

    for (let i = searchEnd; i >= start; i--) {
      if (swingHigh == null && isPivotHigh(highs, i, pivotBars)) {
        swingHigh = highs[i];
        swingHighIndex = i;
      }
      if (swingLow == null && isPivotLow(lows, i, pivotBars)) {
        swingLow = lows[i];
        swingLowIndex = i;
      }
      if (swingHigh != null && swingLow != null) break;
    }

    return { swingHigh, swingLow, swingHighIndex, swingLowIndex };
  }

  function nearLevel(price, level, tolerancePct) {
    if (level == null || level <= 0) return false;
    return (Math.abs(price - level) / level) * 100 <= tolerancePct;
  }

  function aboveLevel(price, level) {
    return level != null && price > level;
  }

  function belowLevel(price, level) {
    return level != null && price < level;
  }

  function swingLongOk(price, swingHigh, swingLow, settings) {
    if (!settings.useSwingLevels) return true;
    const mode = settings.swingMode || 'bounce';
    if (mode === 'breakout') return aboveLevel(price, swingHigh);
    return nearLevel(price, swingLow, settings.swingNearPct);
  }

  function swingShortOk(price, swingHigh, swingLow, settings) {
    if (!settings.useSwingLevels) return true;
    const mode = settings.swingMode || 'bounce';
    if (mode === 'breakout') return belowLevel(price, swingLow);
    return nearLevel(price, swingHigh, settings.swingNearPct);
  }

  function buildPivotMarkers(candles, levels) {
    const { swingHigh, swingLow, swingHighIndex, swingLowIndex } = levels;
    const markers = [];
    if (swingHighIndex != null && swingHigh != null && candles[swingHighIndex]) {
      markers.push({
        time: candles[swingHighIndex].time,
        position: 'aboveBar',
        color: '#ef5350',
        shape: 'circle',
        text: `H ${Math.round(swingHigh)}`,
      });
    }
    if (swingLowIndex != null && swingLow != null && candles[swingLowIndex]) {
      markers.push({
        time: candles[swingLowIndex].time,
        position: 'belowBar',
        color: '#26a69a',
        shape: 'circle',
        text: `L ${Math.round(swingLow)}`,
      });
    }
    return markers;
  }

  function calcFromCandles(candles, settings) {
    if (!candles?.length) {
      return { swingHigh: null, swingLow: null, swingHighIndex: null, swingLowIndex: null };
    }
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    return recentSwingLevels(highs, lows, candles.length - 1, {
      pivotBars: settings.swingPivotBars || 5,
      lookback: settings.swingLookback || 50,
    });
  }

  function calcStopPrice(side, swingHigh, swingLow, bufferPct) {
    if (side === 'LONG' && swingLow != null) {
      return Math.round(swingLow * (1 - bufferPct / 100) * 100) / 100;
    }
    if (side === 'SHORT' && swingHigh != null) {
      return Math.round(swingHigh * (1 + bufferPct / 100) * 100) / 100;
    }
    return null;
  }

  function calcStopFromCandles(candles, side, settings) {
    if (!settings.useSwingStopLoss || !candles?.length) return null;
    const levels = calcFromCandles(candles, settings);
    return calcStopPrice(
      side,
      levels.swingHigh,
      levels.swingLow,
      settings.swingStopBufferPct ?? 0.2,
    );
  }

  return {
    isPivotHigh,
    isPivotLow,
    recentSwingLevels,
    nearLevel,
    aboveLevel,
    belowLevel,
    swingLongOk,
    swingShortOk,
    buildPivotMarkers,
    calcFromCandles,
    calcStopPrice,
    calcStopFromCandles,
  };
})();

window.SwingLevels = SwingLevels;
