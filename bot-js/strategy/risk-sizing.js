/* Risk-based position sizing — max loss as % of equity at stop-loss */

const RiskSizing = (() => {

  function resolveStopLossPctForSizing(entryLevels, fallbackStopLossPct) {
    const fromLevels = parseFloat(entryLevels?.stopLossPct);
    if (Number.isFinite(fromLevels) && fromLevels > 0) return fromLevels;
    const fallback = parseFloat(fallbackStopLossPct);
    if (Number.isFinite(fallback) && fallback > 0) return fallback;
    return null;
  }

  function calcTradeMarginForEntry(equity, riskSettings, entryLevels) {
    const stopLossPct = resolveStopLossPctForSizing(entryLevels, riskSettings.stopLossPct);
    return calcTradeMargin(equity, { ...riskSettings, stopLossPct });
  }

  function calcTradeMargin(equity, settings) {

    const {

      riskPerTradePct,

      leverage,

      stopLossPct,

      minMargin = 5,

    } = settings;



    if (equity <= 0 || stopLossPct <= 0 || leverage <= 0 || riskPerTradePct <= 0) {

      return minMargin;

    }



    const margin = (equity * riskPerTradePct) / (leverage * stopLossPct);

    return Math.max(Math.round(Math.min(margin, equity * 0.95) * 100) / 100, minMargin);

  }



  function isAccountLossLimitHit(equity, referenceEquity, maxAccountLossPct) {

    if (referenceEquity <= 0 || maxAccountLossPct <= 0) return false;

    const drawdownPct = ((referenceEquity - equity) / referenceEquity) * 100;

    return drawdownPct >= maxAccountLossPct;

  }



  function estimateLossAtSl(margin, leverage, stopLossPct) {

    return margin * leverage * (stopLossPct / 100);

  }



  return {
    calcTradeMargin,
    calcTradeMarginForEntry,
    resolveStopLossPctForSizing,
    isAccountLossLimitHit,
    estimateLossAtSl,
  };

})();



window.RiskSizing = RiskSizing;

