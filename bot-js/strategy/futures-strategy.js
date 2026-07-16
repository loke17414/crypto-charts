/* Multi-indicator rule-based futures strategy */
const FuturesStrategy = (() => {
  const DEFAULT_STOP_LOSS_PCT = 1.5;
  const DEFAULT_TAKE_PROFIT_PCT = 3;

  function getStopLossPct(settings) {
    const n = parseFloat(settings?.stopLossPct);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_STOP_LOSS_PCT;
    return n;
  }

  function getTakeProfitPct(settings) {
    const n = parseFloat(settings?.takeProfitPct);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_TAKE_PROFIT_PCT;
    return n;
  }

  function useStopLossActive(settings, positionExtras = {}) {
    if (positionExtras.useStopLoss === false) return false;
    return settings?.useStopLoss !== false;
  }

  function resolveStopPrice(side, entryPrice, slPct, override, useSl) {
    if (!useSl) return null;
    if (override != null && Number.isFinite(override)) return override;
    if (side === 'LONG') return entryPrice * (1 - slPct / 100);
    if (side === 'SHORT') return entryPrice * (1 + slPct / 100);
    return null;
  }

  function atrAt(candles, index, period) {
    if (index < 1) return null;
    const p = Math.max(1, parseInt(period, 10) || 14);
    const start = Math.max(1, index - p + 1);
    let sum = 0;
    let count = 0;
    for (let i = start; i <= index; i++) {
      const h = candles[i].high;
      const l = candles[i].low;
      const prevClose = candles[i - 1].close;
      sum += Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
      count += 1;
    }
    return count ? sum / count : null;
  }

  function calcDynamicEntryLevels(side, entryPrice, candles, index, exitRule) {
    const entry = parseFloat(entryPrice);
    if (!Number.isFinite(entry) || entry <= 0 || !exitRule) return null;

    let stopPrice = null;
    const sl = exitRule.stopLoss;
    if (sl?.type === 'candle_extreme') {
      const off = parseInt(sl.offset, 10) || 1;
      const barIdx = index - off;
      const bar = barIdx >= 0 ? candles[barIdx] : null;
      const field = sl.field || (side === 'LONG' ? 'low' : 'high');
      stopPrice = bar?.[field];
    } else if (sl?.type === 'atr') {
      const atr = atrAt(candles, index, sl.period);
      const mult = parseFloat(sl.mult) || 1.5;
      if (Number.isFinite(atr) && atr > 0) {
        stopPrice = side === 'LONG' ? entry - atr * mult : entry + atr * mult;
      }
    }

    if (!Number.isFinite(stopPrice) || stopPrice <= 0) return null;

    let takeProfitPrice = null;
    const tp = exitRule.takeProfit;
    if (tp?.type === 'risk_reward') {
      const ratio = parseFloat(tp.ratio) || 1.5;
      if (side === 'LONG') {
        const risk = entry - stopPrice;
        if (risk <= 0) return null;
        takeProfitPrice = entry + risk * ratio;
      } else {
        const risk = stopPrice - entry;
        if (risk <= 0) return null;
        takeProfitPrice = entry - risk * ratio;
      }
    }

    if (!Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0) return null;

    const stopLossPct = side === 'LONG'
      ? ((entry - stopPrice) / entry) * 100
      : ((stopPrice - entry) / entry) * 100;
    const takeProfitPct = side === 'LONG'
      ? ((takeProfitPrice - entry) / entry) * 100
      : ((entry - takeProfitPrice) / entry) * 100;

    return {
      side,
      stopPrice,
      takeProfitPrice,
      stopLossPct,
      takeProfitPct,
      dynamic: true,
    };
  }

  let dynamicFallbackWarned = false;

  function calcEntryLevels(side, entryPrice, settings, context = {}) {
    const exitRule = settings?.exitRules?.[side.toLowerCase()];
    if (exitRule && context.candles && context.index != null) {
      const dynamic = calcDynamicEntryLevels(
        side,
        entryPrice,
        context.candles,
        context.index,
        exitRule,
      );
      if (dynamic) return stripStopLossIfDisabled(dynamic, settings);
      if (!dynamicFallbackWarned) {
        dynamicFallbackWarned = true;
        console.warn(
          `[FuturesStrategy] 동적 SL/TP 계산 실패 (${side}) — 고정 %로 대체합니다. exitRule:`,
          exitRule,
        );
      }
    }

    const entry = parseFloat(entryPrice);
    if (!Number.isFinite(entry) || entry <= 0) return null;
    const stopLossPct = getStopLossPct(settings);
    const takeProfitPct = getTakeProfitPct(settings);
    if (side === 'LONG') {
      return stripStopLossIfDisabled({
        side: 'LONG',
        stopPrice: entry * (1 - stopLossPct / 100),
        takeProfitPrice: entry * (1 + takeProfitPct / 100),
        stopLossPct,
        takeProfitPct,
      }, settings);
    }
    if (side === 'SHORT') {
      return stripStopLossIfDisabled({
        side: 'SHORT',
        stopPrice: entry * (1 + stopLossPct / 100),
        takeProfitPrice: entry * (1 - takeProfitPct / 100),
        stopLossPct,
        takeProfitPct,
      }, settings);
    }
    return null;
  }

  function stripStopLossIfDisabled(levels, settings) {
    if (!levels || settings?.useStopLoss !== false) return levels;
    return { ...levels, stopPrice: null, stopLossPct: null };
  }

  function calcLongEntryLevels(entryPrice, settings) {
    return calcEntryLevels('LONG', entryPrice, settings);
  }

  function minBars(settings) {
    if (window.StrategyEngine) return StrategyEngine.minBars(settings);
    return (settings.rsiPeriod || 14) + 2;
  }

  function analyze(candles, settings, currentSide) {
    if (!window.StrategyEngine) {
      return { signal: 'HOLD', reason: 'StrategyEngine 로드 실패', snapshot: null };
    }

    if (candles.length < minBars(settings)) {
      return { signal: 'HOLD', reason: '데이터 부족', snapshot: null };
    }

    const entry = StrategyEngine.evaluateEntry(candles, settings, currentSide);
    const slPct = getStopLossPct(settings);
    const tpPct = getTakeProfitPct(settings);
    const snapshot = entry.snapshot;

    if (!entry.matched) {
      if (currentSide === 'LONG' || currentSide === 'SHORT') {
        const label = currentSide === 'LONG' ? '롱' : '숏';
        return {
          signal: 'HOLD',
          reason: `${label} 보유 — 손절 -${slPct}% / 익절 +${tpPct}% 대기`,
          snapshot,
        };
      }
      return { signal: 'HOLD', reason: entry.reason, snapshot };
    }

    const price = snapshot?.price ?? candles.at(-1)?.close;
    const barIndex = candles.length - 1;
    // The matched slot's own exitRules (dynamic SL/TP) win over the global ones.
    const levelSettings = entry.slotExitRules
      ? { ...settings, exitRules: entry.slotExitRules }
      : settings;
    const levels = calcEntryLevels(entry.matched, price, levelSettings, { candles, index: barIndex });
    if (!levels) {
      return { signal: 'HOLD', reason: '손절/익절 계산 불가', snapshot };
    }

    // With stop-loss disabled, stopPrice/stopLossPct are stripped to null.
    let slLabel;
    if (levels.stopPrice == null && levels.stopLossPct == null) {
      slLabel = '없음';
    } else {
      slLabel = levels.dynamic
        ? `$${levels.stopPrice.toFixed(0)}`
        : `-${levels.stopLossPct.toFixed(1)}%`;
    }
    const tpLabel = levels.dynamic
      ? `$${levels.takeProfitPrice.toFixed(0)}`
      : `+${levels.takeProfitPct.toFixed(1)}%`;

    return {
      signal: entry.matched,
      reason: `${entry.reason} · SL ${slLabel} · TP ${tpLabel}`,
      snapshot,
      entryLevels: levels,
    };
  }

  function checkExit(side, entryPrice, currentPrice, settings, positionExtras = {}) {
    const slPct = positionExtras.stopLossPct ?? getStopLossPct(settings);
    const tpPct = positionExtras.takeProfitPct ?? getTakeProfitPct(settings);
    const useSl = useStopLossActive(settings, positionExtras);

    if (side === 'LONG') {
      const stopPrice = resolveStopPrice('LONG', entryPrice, slPct, positionExtras.stopPrice, useSl);
      const takeProfitPrice = positionExtras.takeProfitPrice ?? entryPrice * (1 + tpPct / 100);
      if (useSl && stopPrice != null && currentPrice <= stopPrice) {
        return { signal: 'CLOSE', reason: `손절 -${slPct}% ($${stopPrice.toFixed(2)})` };
      }
      if (currentPrice >= takeProfitPrice) {
        return { signal: 'CLOSE', reason: `익절 +${tpPct}% ($${takeProfitPrice.toFixed(2)})` };
      }
      return null;
    }

    if (side === 'SHORT') {
      const stopPrice = resolveStopPrice('SHORT', entryPrice, slPct, positionExtras.stopPrice, useSl);
      const takeProfitPrice = positionExtras.takeProfitPrice ?? entryPrice * (1 - tpPct / 100);
      if (useSl && stopPrice != null && currentPrice >= stopPrice) {
        return { signal: 'CLOSE', reason: `손절 -${slPct}% ($${stopPrice.toFixed(2)})` };
      }
      if (currentPrice <= takeProfitPrice) {
        return { signal: 'CLOSE', reason: `익절 +${tpPct}% ($${takeProfitPrice.toFixed(2)})` };
      }
    }
    return null;
  }

  // Backtest-only exit check that uses the candle's HIGH/LOW (wick) rather than
  // just the close, so an intrabar touch of the stop/take-profit is detected.
  // Fills are realistic: a stop the bar gaps past fills at the open (worse than
  // the trigger), a take-profit gapped past also fills at the open (better).
  // When one bar's wick touches BOTH levels, the level closer to the open is
  // assumed to have been hit first (ties go to the stop — pessimistic).
  function checkExitBar(side, entryPrice, candle, settings, positionExtras = {}) {
    if (side !== 'LONG' && side !== 'SHORT') return null;
    const slPct = positionExtras.stopLossPct ?? getStopLossPct(settings);
    const tpPct = positionExtras.takeProfitPct ?? getTakeProfitPct(settings);
    const useSl = useStopLossActive(settings, positionExtras);
    const { high, low, open } = candle;
    const isLong = side === 'LONG';

    const stopPrice = resolveStopPrice(side, entryPrice, slPct, positionExtras.stopPrice, useSl);
    const takeProfitPrice = positionExtras.takeProfitPrice
      ?? (isLong ? entryPrice * (1 + tpPct / 100) : entryPrice * (1 - tpPct / 100));

    const hitSl = useSl && stopPrice != null && (isLong ? low <= stopPrice : high >= stopPrice);
    const hitTp = isLong ? high >= takeProfitPrice : low <= takeProfitPrice;
    if (!hitSl && !hitTp) return null;

    // slExit is only built when the stop actually hit (stopPrice may be null
    // when stop-loss is disabled — building the label eagerly would crash).
    const slExit = hitSl
      ? {
        signal: 'CLOSE',
        reason: `손절 -${slPct}% ($${stopPrice.toFixed(2)})`,
        exitPrice: isLong ? Math.min(stopPrice, open) : Math.max(stopPrice, open),
      }
      : null;
    const tpFill = isLong ? Math.max(takeProfitPrice, open) : Math.min(takeProfitPrice, open);
    const tpExit = { signal: 'CLOSE', reason: `익절 +${tpPct}% ($${takeProfitPrice.toFixed(2)})`, exitPrice: tpFill };

    if (hitSl && hitTp) {
      const distSl = Math.abs(open - stopPrice);
      const distTp = Math.abs(open - takeProfitPrice);
      return distSl <= distTp ? slExit : tpExit;
    }
    return hitSl ? slExit : tpExit;
  }

  function calcPnlPct(side, entryPrice, exitPrice) {
    return side === 'LONG'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;
  }

  return {
    analyze,
    checkExit,
    checkExitBar,
    calcPnlPct,
    calcEntryLevels,
    calcDynamicEntryLevels,
    calcLongEntryLevels,
    minBars,
  };
})();

window.FuturesStrategy = FuturesStrategy;
