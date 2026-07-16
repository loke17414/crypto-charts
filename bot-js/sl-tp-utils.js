'use strict';

/**
 * Shift SL/TP $ distances from the signal reference price to the actual fill.
 * Prevents Binance conditional orders from firing immediately when fill
 * price differs from the candle close used for level calculation.
 */
function shiftLevelsToFill(side, refPrice, entryPrice, levels) {
  if (!levels || !Number.isFinite(refPrice) || !Number.isFinite(entryPrice)) return levels;
  if (refPrice <= 0 || entryPrice <= 0) return levels;
  if (Math.abs(refPrice - entryPrice) < refPrice * 1e-5) return levels;

  let stopPrice = levels.stopPrice;
  let takeProfitPrice = levels.takeProfitPrice;

  if (side === 'LONG') {
    if (stopPrice != null) stopPrice = entryPrice - (refPrice - stopPrice);
    if (takeProfitPrice != null) takeProfitPrice = entryPrice + (takeProfitPrice - refPrice);
  } else if (side === 'SHORT') {
    if (stopPrice != null) stopPrice = entryPrice + (stopPrice - refPrice);
    if (takeProfitPrice != null) takeProfitPrice = entryPrice - (refPrice - takeProfitPrice);
  }

  const stopLossPct = stopPrice != null
    ? (side === 'LONG'
      ? ((entryPrice - stopPrice) / entryPrice) * 100
      : ((stopPrice - entryPrice) / entryPrice) * 100)
    : levels.stopLossPct ?? null;
  const takeProfitPct = takeProfitPrice != null
    ? (side === 'LONG'
      ? ((takeProfitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - takeProfitPrice) / entryPrice) * 100)
    : levels.takeProfitPct ?? null;

  return {
    ...levels,
    stopPrice,
    takeProfitPrice,
    stopLossPct,
    takeProfitPct,
  };
}

function validateSlTp(side, entryPrice, stopPrice, takeProfitPrice, markPrice) {
  const issues = [];
  if (!side || !Number.isFinite(entryPrice) || entryPrice <= 0) return issues;

  if (side === 'LONG') {
    if (stopPrice != null) {
      if (stopPrice >= entryPrice) issues.push(`SL $${stopPrice} must be below entry $${entryPrice}`);
      if (markPrice != null && stopPrice >= markPrice) {
        issues.push(`SL $${stopPrice} at/above mark $${markPrice} (즉시 체결)`);
      }
    }
    if (takeProfitPrice != null) {
      if (takeProfitPrice <= entryPrice) issues.push(`TP $${takeProfitPrice} must be above entry $${entryPrice}`);
      if (markPrice != null && takeProfitPrice <= markPrice) {
        issues.push(`TP $${takeProfitPrice} at/below mark $${markPrice} (즉시 체결)`);
      }
    }
  } else if (side === 'SHORT') {
    if (stopPrice != null) {
      if (stopPrice <= entryPrice) issues.push(`SL $${stopPrice} must be above entry $${entryPrice}`);
      if (markPrice != null && stopPrice <= markPrice) {
        issues.push(`SL $${stopPrice} at/below mark $${markPrice} (즉시 체결)`);
      }
    }
    if (takeProfitPrice != null) {
      if (takeProfitPrice >= entryPrice) issues.push(`TP $${takeProfitPrice} must be below entry $${entryPrice}`);
      if (markPrice != null && takeProfitPrice >= markPrice) {
        issues.push(`TP $${takeProfitPrice} at/above mark $${markPrice} (즉시 체결)`);
      }
    }
  }
  return issues;
}

module.exports = { shiftLevelsToFill, validateSlTp };
