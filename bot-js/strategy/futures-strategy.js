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
      levelSettings,
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

  // ── 세그먼트 백테스트: "최신 → 과거" 원칙의 핵심 ─────────────────────────
  // 캔들을 절대시간 기준 고정 구간(SEGMENT_BARS봉)으로 나눠 각 구간을 독립적으로
  // 시뮬레이션한다. 구간 경계가 창 크기와 무관하게 결정적이므로, 과거 데이터를
  // 더 받아와도 이미 계산된 최신 구간의 거래는 변하지 않는다. 예전에는 전체를
  // 한 번에 돌려서, 새로 추가된 과거 진입이 포지션을 오래 점유하면 그 뒤의
  // (이미 세었던) 최근 거래들이 사라져 로딩 중 횟수가 줄어드는 문제가 있었다.
  const SEGMENT_BARS = 5000;

  function segmentSpanSec(candles) {
    // 봉 간격 추정 — 결측 봉이 있어도 중앙값이면 안전하다.
    const deltas = [];
    for (let i = 1; i < Math.min(candles.length, 30); i++) {
      deltas.push(candles[i].time - candles[i - 1].time);
    }
    deltas.sort((a, b) => a - b);
    const dt = deltas[Math.floor(deltas.length / 2)] || 60;
    return SEGMENT_BARS * dt;
  }

  function backtest(candles, settings, options = {}) {
    const { maxTrades = null, skipMarkers = false } = options;
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

    const minStart = minBars(settings);
    // 각 구간 앞에 붙이는 지표 워밍업 컨텍스트. 길이가 항상 고정이라
    // 창을 과거로 넓혀도 구간 안의 지표값·거래가 변하지 않는다.
    const warmupBars = Math.max(300, minStart * 3);
    const span = segmentSpanSec(candles);

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

    // 구간 경계는 절대시간(epoch) 기준으로 고정 — 데이터 창을 과거로 넓혀도
    // 같은 시각의 봉은 항상 같은 구간에 속해 결과가 변하지 않는다.
    const segments = [];
    if (candles.length) {
      let segStart = 0;
      let bucket = Math.floor(candles[0].time / span);
      for (let i = 1; i <= candles.length; i++) {
        const b = i < candles.length ? Math.floor(candles[i].time / span) : null;
        if (b !== bucket) {
          segments.push([segStart, i]);
          segStart = i;
          bucket = b;
        }
      }
    }

    // 각 구간은 독립 시뮬레이션 (시간순, 구간 안에서도 과거 → 최신으로 진행).
    // 구간 앞 warmupBars봉은 지표 계산 컨텍스트로만 쓰고 진입은 평가하지 않는다.
    // maxTrades는 루프 중간에 끊지 않는다 — 오래된 구간에서 N건을 채우고 멈추면
    // kept = slice(-N)이 최신 거래가 아닌 과거 거래만 남아 차트 오른쪽에 마커가 없다.
    for (const [from, to] of segments) {
      const ctxStart = Math.max(0, from - warmupBars);
      const ctx = candles.slice(ctxStart, to);
      const { slots, rules, cache, startIdx: warmupIdx } = StrategyEngine.prepareBacktest(ctx, settings);
      const startLocal = Math.max(from - ctxStart, warmupIdx, minStart);
      position = null;

      for (let i = startLocal; i < ctx.length; i++) {
        const candle = ctx[i];

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
            ? StrategyEngine.matchEntrySlotsAt(ctx, i, slots, cache, null)
            : null;
          const matched = hit?.side ?? StrategyEngine.matchEntryAt(ctx, i, rules, cache, null);
          if (matched === 'LONG' || matched === 'SHORT') {
            const levelSettings = hit?.slot?.exitRules
              ? { ...settings, exitRules: hit.slot.exitRules }
              : settings;
            const levels = calcEntryLevels(matched, candle.close, levelSettings, { candles: ctx, index: i });
            if (levels) openPosition(candle, matched, levels, hit?.slot?.name);
          }
        }
      }

      // 구간 끝에서 아직 열려 있는 포지션은 세지 않는다 — 미래 데이터에 따라
      // 결과가 달라질 수 있는 거래를 확정하지 않아야 횟수가 안정적이다.
      position = null;
    }

    const totalTrades = trades.length;
    const kept = maxTrades != null && trades.length > maxTrades
      ? trades.slice(-maxTrades)
      : trades;

    for (const t of kept) {
      if (skipMarkers) continue;
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
        rangeFromTime: kept[0]?.entryTime ?? candles[0]?.time ?? null,
        rangeToTime: kept.at(-1)?.exitTime ?? candles.at(-1)?.time ?? null,
        targetTrades: maxTrades,
        targetReached: maxTrades != null && totalTrades >= maxTrades,
      },
    };
  }

  return {
    analyze,
    checkExit,
    checkExitBar,
    backtest,
    calcPnlPct,
    calcEntryLevels,
    calcDynamicEntryLevels,
    calcLongEntryLevels,
    minBars,
  };
})();

window.FuturesStrategy = FuturesStrategy;
