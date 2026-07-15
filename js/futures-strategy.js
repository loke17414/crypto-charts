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
      if (dynamic) return dynamic;
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
      return {
        side: 'LONG',
        stopPrice: entry * (1 - stopLossPct / 100),
        takeProfitPrice: entry * (1 + takeProfitPct / 100),
        stopLossPct,
        takeProfitPct,
      };
    }
    if (side === 'SHORT') {
      return {
        side: 'SHORT',
        stopPrice: entry * (1 + stopLossPct / 100),
        takeProfitPrice: entry * (1 - takeProfitPct / 100),
        stopLossPct,
        takeProfitPct,
      };
    }
    return null;
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

    const slLabel = levels.dynamic
      ? `$${levels.stopPrice.toFixed(0)}`
      : `-${levels.stopLossPct.toFixed(1)}%`;
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

    if (side === 'LONG') {
      const stopPrice = positionExtras.stopPrice ?? entryPrice * (1 - slPct / 100);
      const takeProfitPrice = positionExtras.takeProfitPrice ?? entryPrice * (1 + tpPct / 100);
      if (currentPrice <= stopPrice) {
        return { signal: 'CLOSE', reason: `손절 -${slPct}% ($${stopPrice.toFixed(2)})` };
      }
      if (currentPrice >= takeProfitPrice) {
        return { signal: 'CLOSE', reason: `익절 +${tpPct}% ($${takeProfitPrice.toFixed(2)})` };
      }
      return null;
    }

    if (side === 'SHORT') {
      const stopPrice = positionExtras.stopPrice ?? entryPrice * (1 + slPct / 100);
      const takeProfitPrice = positionExtras.takeProfitPrice ?? entryPrice * (1 - tpPct / 100);
      if (currentPrice >= stopPrice) {
        return { signal: 'CLOSE', reason: `손절 -${slPct}% ($${stopPrice.toFixed(2)})` };
      }
      if (currentPrice <= takeProfitPrice) {
        return { signal: 'CLOSE', reason: `익절 +${tpPct}% ($${takeProfitPrice.toFixed(2)})` };
      }
    }
    return null;
  }

  // Backtest-only exit check that uses the candle's HIGH/LOW (wick) rather than
  // just the close, so an intrabar touch of the stop/take-profit is detected and
  // the trade exits at the actual SL/TP price. When both levels are touched on
  // one bar, use open vs entry to pick the more likely path first.
  function checkExitBar(side, entryPrice, candle, settings, positionExtras = {}) {
    const slPct = positionExtras.stopLossPct ?? getStopLossPct(settings);
    const tpPct = positionExtras.takeProfitPct ?? getTakeProfitPct(settings);
    const { high, low, open, close } = candle;

    if (side === 'LONG') {
      const stopPrice = positionExtras.stopPrice ?? entryPrice * (1 - slPct / 100);
      const takeProfitPrice = positionExtras.takeProfitPrice ?? entryPrice * (1 + tpPct / 100);
      const hitSl = low <= stopPrice;
      const hitTp = high >= takeProfitPrice;
      if (hitSl && hitTp) {
        if (open >= entryPrice) {
          return { signal: 'CLOSE', reason: `손절 -${slPct}% ($${stopPrice.toFixed(2)})`, exitPrice: stopPrice };
        }
        return { signal: 'CLOSE', reason: `익절 +${tpPct}% ($${takeProfitPrice.toFixed(2)})`, exitPrice: takeProfitPrice };
      }
      if (hitSl) {
        return { signal: 'CLOSE', reason: `손절 -${slPct}% ($${stopPrice.toFixed(2)})`, exitPrice: stopPrice };
      }
      if (hitTp) {
        return { signal: 'CLOSE', reason: `익절 +${tpPct}% ($${takeProfitPrice.toFixed(2)})`, exitPrice: takeProfitPrice };
      }
      return null;
    }

    if (side === 'SHORT') {
      const stopPrice = positionExtras.stopPrice ?? entryPrice * (1 + slPct / 100);
      const takeProfitPrice = positionExtras.takeProfitPrice ?? entryPrice * (1 - tpPct / 100);
      const hitSl = high >= stopPrice;
      const hitTp = low <= takeProfitPrice;
      if (hitSl && hitTp) {
        if (open <= entryPrice) {
          return { signal: 'CLOSE', reason: `손절 -${slPct}% ($${stopPrice.toFixed(2)})`, exitPrice: stopPrice };
        }
        return { signal: 'CLOSE', reason: `익절 +${tpPct}% ($${takeProfitPrice.toFixed(2)})`, exitPrice: takeProfitPrice };
      }
      if (hitSl) {
        return { signal: 'CLOSE', reason: `손절 -${slPct}% ($${stopPrice.toFixed(2)})`, exitPrice: stopPrice };
      }
      if (hitTp) {
        return { signal: 'CLOSE', reason: `익절 +${tpPct}% ($${takeProfitPrice.toFixed(2)})`, exitPrice: takeProfitPrice };
      }
      return null;
    }

    void close;
    return null;
  }

  function calcPnlPct(side, entryPrice, exitPrice) {
    return side === 'LONG'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;
  }

  function backtest(candles, settings, options = {}) {
    const { maxTrades = null } = options;
    const trades = [];
    const markers = [];
    let position = null;

    if (!window.StrategyEngine?.prepareBacktest) {
      return {
        trades,
        markers,
        stats: {
          trades: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          totalPnlPct: 0,
          candlesUsed: candles.length,
          rangeFromTime: null,
          rangeToTime: candles.at(-1)?.time ?? null,
          targetTrades: maxTrades,
          targetReached: false,
        },
      };
    }

    const { slots, rules, cache, startIdx: warmupIdx } = StrategyEngine.prepareBacktest(candles, settings);
    const minStart = minBars(settings);
    const startIdx = Math.max(warmupIdx, minStart);

    function closePosition(candle, reason, exitPrice = candle.close) {
      const pnlPct = calcPnlPct(position.side, position.entryPrice, exitPrice);
      trades.push({
        side: position.side,
        entryTime: position.entryTime,
        entryPrice: position.entryPrice,
        exitTime: candle.time,
        exitPrice,
        stopPrice: position.stopPrice,
        takeProfitPrice: position.takeProfitPrice,
        pnlPct,
        reason,
        slotName: position.slotName ?? null,
      });
      position = null;
    }

    function openPosition(candle, side, levels, slotName = null) {
      position = {
        side,
        entryPrice: candle.close,
        entryTime: candle.time,
        stopPrice: levels.stopPrice,
        takeProfitPrice: levels.takeProfitPrice,
        stopLossPct: levels.stopLossPct,
        takeProfitPct: levels.takeProfitPct,
        slotName,
      };
    }

    // Run the full window (oldest → newest). We keep the MOST RECENT maxTrades
    // afterwards so backtest results reflect the latest trades, not the oldest.
    for (let i = startIdx; i < candles.length; i++) {
      const candle = candles[i];

      if (position) {
        const slTp = checkExitBar(position.side, position.entryPrice, candle, settings, {
          stopPrice: position.stopPrice,
          takeProfitPrice: position.takeProfitPrice,
          stopLossPct: position.stopLossPct,
          takeProfitPct: position.takeProfitPct,
        });
        if (slTp) {
          closePosition(candle, slTp.reason, slTp.exitPrice);
          continue;
        }
      }

      if (!position) {
        const hit = StrategyEngine.matchEntrySlotsAt
          ? StrategyEngine.matchEntrySlotsAt(candles, i, slots, cache, null)
          : null;
        const matched = hit?.side ?? StrategyEngine.matchEntryAt(candles, i, rules, cache, null);
        if (matched === 'LONG' || matched === 'SHORT') {
          const levelSettings = hit?.slot?.exitRules
            ? { ...settings, exitRules: hit.slot.exitRules }
            : settings;
          const levels = calcEntryLevels(matched, candle.close, levelSettings, { candles, index: i });
          if (levels) openPosition(candle, matched, levels, hit?.slot?.name);
        }
      }
    }

    const totalTrades = trades.length;
    const kept = maxTrades != null && trades.length > maxTrades
      ? trades.slice(-maxTrades)
      : trades;

    for (const t of kept) {
      const prefix = t.side === 'LONG' ? 'L' : 'S';
      markers.push({
        time: t.entryTime,
        position: t.side === 'LONG' ? 'belowBar' : 'aboveBar',
        color: t.side === 'LONG' ? '#26a69a' : '#ef5350',
        shape: t.side === 'LONG' ? 'arrowUp' : 'arrowDown',
        text: t.side,
      });
      markers.push({
        time: t.exitTime,
        position: 'aboveBar',
        color: t.pnlPct >= 0 ? '#26a69a' : '#ef5350',
        shape: 'circle',
        text: `${prefix}청산 ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`,
      });
    }

    const wins = kept.filter((t) => t.pnlPct >= 0).length;
    const totalPnl = kept.reduce((s, t) => s + t.pnlPct, 0);
    return {
      trades: kept,
      markers,
      stats: {
        trades: kept.length,
        totalTrades,
        wins,
        losses: kept.length - wins,
        winRate: kept.length ? (wins / kept.length) * 100 : 0,
        totalPnlPct: totalPnl,
        candlesUsed: candles.length,
        rangeFromTime: kept[0]?.entryTime ?? candles[startIdx]?.time ?? null,
        rangeToTime: kept.at(-1)?.exitTime ?? candles.at(-1)?.time ?? null,
        targetTrades: maxTrades,
        targetReached: maxTrades != null && totalTrades >= maxTrades,
      },
    };
  }

  return {
    analyze,
    checkExit,
    backtest,
    calcPnlPct,
    calcEntryLevels,
    calcDynamicEntryLevels,
    calcLongEntryLevels,
    minBars,
  };
})();

window.FuturesStrategy = FuturesStrategy;
