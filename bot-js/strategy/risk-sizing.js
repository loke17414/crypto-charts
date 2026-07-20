/* Risk-based position sizing — max loss as % of equity at stop-loss (includes trading fee) */

const RiskSizing = (() => {
  /** Round-trip fee (% of notional / price) applied to risk sizing and RR exits. */
  const TRADING_FEE_PCT = 0.1;

  function resolveStopLossPctForSizing(entryLevels, fallbackStopLossPct) {
    const fromLevels = parseFloat(entryLevels?.stopLossPct);
    if (Number.isFinite(fromLevels) && fromLevels > 0) return fromLevels;
    const fallback = parseFloat(fallbackStopLossPct);
    if (Number.isFinite(fallback) && fallback > 0) return fallback;
    return null;
  }

  /** SL% + round-trip fee% — used so sized loss includes commission. */
  function effectiveStopLossPct(stopLossPct, feePct = TRADING_FEE_PCT) {
    const sl = parseFloat(stopLossPct);
    const fee = parseFloat(feePct);
    if (!Number.isFinite(sl) || sl <= 0) return null;
    const f = Number.isFinite(fee) && fee > 0 ? fee : 0;
    return sl + f;
  }

  /** Max USDT loss at SL for the configured 1-trade risk %. */
  function targetLossUsdt(equity, riskPerTradePct) {
    if (!(equity > 0) || !(riskPerTradePct > 0)) return 0;
    return equity * (riskPerTradePct / 100);
  }

  /**
   * Margin so that: margin × leverage × (effectiveSL%/100) = equity × (risk%/100)
   * effectiveSL = stopLossPct + TRADING_FEE_PCT (0.1%)
   */
  function calcTradeMargin(equity, settings) {
    const {
      riskPerTradePct,
      leverage,
      stopLossPct,
      minMargin = 5,
      feePct = TRADING_FEE_PCT,
    } = settings;

    const effSl = effectiveStopLossPct(stopLossPct, feePct);
    if (equity <= 0 || !effSl || leverage <= 0 || riskPerTradePct <= 0) {
      return minMargin;
    }

    const margin = (equity * riskPerTradePct) / (leverage * effSl);
    return Math.max(Math.round(Math.min(margin, equity) * 100) / 100, minMargin);
  }

  function calcTradeMarginForEntry(equity, riskSettings, entryLevels) {
    const stopLossPct = resolveStopLossPctForSizing(entryLevels, riskSettings.stopLossPct);
    return calcTradeMargin(equity, { ...riskSettings, stopLossPct });
  }

  function estimateLossAtSl(margin, leverage, stopLossPct, feePct = TRADING_FEE_PCT) {
    const effSl = effectiveStopLossPct(stopLossPct, feePct);
    if (!(margin > 0) || !(leverage > 0) || !effSl) return 0;
    return margin * leverage * (effSl / 100);
  }

  function summarizeRiskPlan(equity, riskSettings, entryLevels) {
    const stopLossPct = resolveStopLossPctForSizing(entryLevels, riskSettings.stopLossPct);
    const feePct = TRADING_FEE_PCT;
    const effSl = effectiveStopLossPct(stopLossPct, feePct);
    // No SL distance (손절 OFF / SL 0%): risk-based sizing is impossible, so
    // fall back to margin = equity × risk% — the same convention the UI uses
    // in PnL mode (see futures-bot-app calcTradeMarginForLevels). Entry must
    // NOT be skipped just because SL is off.
    const sizedWithoutSl = stopLossPct == null;
    const margin = sizedWithoutSl
      ? Math.max(5, Math.round(((equity * (riskSettings.riskPerTradePct || 0)) / 100) * 100) / 100)
      : calcTradeMargin(equity, { ...riskSettings, stopLossPct, feePct });
    const targetLoss = targetLossUsdt(equity, riskSettings.riskPerTradePct);
    const lossAtSl = estimateLossAtSl(margin, riskSettings.leverage, stopLossPct, feePct);
    return {
      equity,
      stopLossPct,
      effectiveStopLossPct: effSl,
      feePct,
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

  /**
   * Price distance for TP so that net RR after round-trip fee equals `ratio`.
   * reward = ratio * (risk + fee) + fee  →  (reward - fee) / (risk + fee) = ratio
   */
  function takeProfitDistanceForRiskReward(entryPrice, riskDistance, ratio, feePct = TRADING_FEE_PCT) {
    const entry = parseFloat(entryPrice);
    const risk = parseFloat(riskDistance);
    const rr = parseFloat(ratio);
    if (!(entry > 0) || !(risk > 0) || !(rr > 0)) return null;
    const fee = Number.isFinite(feePct) && feePct > 0 ? entry * (feePct / 100) : 0;
    return rr * (risk + fee) + fee;
  }

  return {
    TRADING_FEE_PCT,
    effectiveStopLossPct,
    calcTradeMargin,
    calcTradeMarginForEntry,
    resolveStopLossPctForSizing,
    targetLossUsdt,
    estimateLossAtSl,
    summarizeRiskPlan,
    isAccountLossLimitHit,
    takeProfitDistanceForRiskReward,
  };

})();

window.RiskSizing = RiskSizing;
