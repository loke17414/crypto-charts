/* Risk-based position sizing — max loss as % of equity at stop-loss */

const RiskSizing = (() => {

  function resolveStopLossPctForSizing(entryLevels, fallbackStopLossPct) {
    const fromLevels = parseFloat(entryLevels?.stopLossPct);
    if (Number.isFinite(fromLevels) && fromLevels > 0) return fromLevels;
    const fallback = parseFloat(fallbackStopLossPct);
    if (Number.isFinite(fallback) && fallback > 0) return fallback;
    return null;
  }

  /** Max USDT loss at SL for the configured 1-trade risk %. */
  function targetLossUsdt(equity, riskPerTradePct) {
    if (!(equity > 0) || !(riskPerTradePct > 0)) return 0;
    return equity * (riskPerTradePct / 100);
  }

  /**
   * Margin so that: margin × leverage × (SL%/100) = equity × (risk%/100)
   * Example: equity 5000, risk 2%, SL 0.4%, 5x → margin 5000
   * Example: equity 8000, risk 2%, SL 0.8%, 5x → margin 4000
   */
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
    return Math.max(Math.round(Math.min(margin, equity) * 100) / 100, minMargin);
  }

  function calcTradeMarginForEntry(equity, riskSettings, entryLevels) {
    const stopLossPct = resolveStopLossPctForSizing(entryLevels, riskSettings.stopLossPct);
    return calcTradeMargin(equity, { ...riskSettings, stopLossPct });
  }

  function estimateLossAtSl(margin, leverage, stopLossPct) {
    if (!(margin > 0) || !(leverage > 0) || !(stopLossPct > 0)) return 0;
    return margin * leverage * (stopLossPct / 100);
  }

  function summarizeRiskPlan(equity, riskSettings, entryLevels) {
    const stopLossPct = resolveStopLossPctForSizing(entryLevels, riskSettings.stopLossPct);
    // No SL distance (손절 OFF / SL 0%): risk-based sizing is impossible, so
    // fall back to margin = equity × risk% — the same convention the UI uses
    // in PnL mode (see futures-bot-app calcTradeMarginForLevels). Entry must
    // NOT be skipped just because SL is off.
    const sizedWithoutSl = stopLossPct == null;
    const margin = sizedWithoutSl
      ? Math.max(5, Math.round(((equity * (riskSettings.riskPerTradePct || 0)) / 100) * 100) / 100)
      : calcTradeMargin(equity, { ...riskSettings, stopLossPct });
    const targetLoss = targetLossUsdt(equity, riskSettings.riskPerTradePct);
    const lossAtSl = estimateLossAtSl(margin, riskSettings.leverage, stopLossPct);
    return {
      equity,
      stopLossPct,
      sizedWithoutSl,
      margin,
      notional: margin * riskSettings.leverage,
      targetLoss,
      lossAtSl,
      riskPerTradePct: riskSettings.riskPerTradePct,
      leverage: riskSettings.leverage,
    };
  }

  function isAccountLossLimitHit(equity, referenceEquity, maxAccountLossPct) {
    if (referenceEquity <= 0 || maxAccountLossPct <= 0) return false;
    const drawdownPct = ((referenceEquity - equity) / referenceEquity) * 100;
    return drawdownPct >= maxAccountLossPct;
  }

  return {
    calcTradeMargin,
    calcTradeMarginForEntry,
    resolveStopLossPctForSizing,
    targetLossUsdt,
    estimateLossAtSl,
    summarizeRiskPlan,
    isAccountLossLimitHit,
  };

})();

window.RiskSizing = RiskSizing;
