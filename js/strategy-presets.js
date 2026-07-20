/**
 * Recommended strategy catalog — live backtest, keep winRate >= 50%, apply to slots / GPT.
 */
(function () {
  'use strict';

  function rrExit(ratio = 1.0, { long = true, short = false } = {}) {
    const out = {};
    if (long) {
      out.long = {
        stopLoss: { type: 'candle_extreme', field: 'low', offset: 1 },
        takeProfit: { type: 'risk_reward', ratio },
      };
    }
    if (short) {
      out.short = {
        stopLoss: { type: 'candle_extreme', field: 'high', offset: 1 },
        takeProfit: { type: 'risk_reward', ratio },
      };
    }
    return out;
  }

  function emptyShort() {
    return { enabled: false, logic: 'all', conditions: [] };
  }

  function pack(entryRules, exitRules, extra = {}) {
    return {
      allowShort: !!(entryRules.short && entryRules.short.enabled),
      entryRules,
      exitRules,
      ...extra,
    };
  }

  /** Candidate pool — measured on the user's chart; top WR>=50% become recommendations. */
  const CATALOG = [
    {
      id: 'rsi-oversold-long',
      name: 'RSI 과매도 롱',
      blurb: 'RSI≤30 롱 · RR 1.0',
      gptPrompt: '추천전략 rsi-oversold-long 적용: RSI(14) 30 이하일 때 롱만. 숏 끔. SL 직전봉 저점, TP 1.0R.',
      build() {
        return pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'rsi', params: { period: 14 }, field: 'value' },
              op: '<=',
              right: { source: 'value', value: 30 },
            }],
          },
          short: emptyShort(),
        }, rrExit(1.0, { long: true }), { rsiPeriod: 14, rsiOversold: 30 });
      },
    },
    {
      id: 'rsi-overbought-short',
      name: 'RSI 과매수 숏',
      blurb: 'RSI≥70 숏 · RR 1.0',
      gptPrompt: '추천전략 rsi-overbought-short 적용: RSI(14) 70 이상일 때 숏만. 롱 끔. SL 직전봉 고점, TP 1.0R.',
      build() {
        return pack({
          long: emptyShort(),
          short: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'rsi', params: { period: 14 }, field: 'value' },
              op: '>=',
              right: { source: 'value', value: 70 },
            }],
          },
        }, rrExit(1.0, { long: false, short: true }), { allowShort: true, rsiOverbought: 70 });
      },
    },
    {
      id: 'rsi-both-meanrev',
      name: 'RSI 양방향 평균회귀',
      blurb: 'RSI≤28 롱 / ≥72 숏 · RR 1.0',
      gptPrompt: '추천전략 rsi-both-meanrev 적용: RSI≤28 롱, RSI≥72 숏. SL 캔들 극단, TP 1.0R.',
      build() {
        return pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'rsi', params: { period: 14 }, field: 'value' },
              op: '<=',
              right: { source: 'value', value: 28 },
            }],
          },
          short: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'rsi', params: { period: 14 }, field: 'value' },
              op: '>=',
              right: { source: 'value', value: 72 },
            }],
          },
        }, rrExit(1.0, { long: true, short: true }), { allowShort: true });
      },
    },
    {
      id: 'bb-reentry-long',
      name: '볼린저 하단 재진입 롱',
      blurb: 'BB 하단 이탈 후 재진입 · RR 1.2',
      gptPrompt: '추천전략 bb-reentry-long 적용: 볼린저 하단 재진입 롱만. SL 직전봉 저점, TP 1.2R.',
      build() {
        const entry = window.StrategyEngine?.bollingerReentryLongPreset?.(20, 2)
          || {
            long: {
              enabled: true,
              logic: 'all',
              conditions: [{
                type: 'band_reentry', side: 'long', indicator: 'boll',
                params: { period: 20, mult: 2 },
              }],
            },
            short: emptyShort(),
          };
        return pack(entry, rrExit(1.2, { long: true }));
      },
    },
    {
      id: 'bb-reentry-short',
      name: '볼린저 상단 재진입 숏',
      blurb: 'BB 상단 이탈 후 재진입 · RR 1.2',
      gptPrompt: '추천전략 bb-reentry-short 적용: 볼린저 상단 재진입 숏만. SL 직전봉 고점, TP 1.2R.',
      build() {
        const entry = window.StrategyEngine?.bandReentryPreset?.('boll', 'short', { period: 20, mult: 2 })
          || {
            long: emptyShort(),
            short: {
              enabled: true,
              logic: 'all',
              conditions: [{
                type: 'band_reentry', side: 'short', indicator: 'boll',
                params: { period: 20, mult: 2 },
              }],
            },
          };
        return pack(entry, rrExit(1.2, { long: false, short: true }), { allowShort: true });
      },
    },
    {
      id: 'stoch-oversold-long',
      name: '스토캐스틱 과매도 롱',
      blurb: 'Stoch K≤20 롱 · RR 1.0',
      gptPrompt: '추천전략 stoch-oversold-long 적용: 스토캐스틱 K≤20 롱만. SL 직전봉 저점, TP 1.0R.',
      build() {
        return pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'stoch', params: { kPeriod: 14, dPeriod: 3 }, field: 'k' },
              op: '<=',
              right: { source: 'value', value: 20 },
            }],
          },
          short: emptyShort(),
        }, rrExit(1.0, { long: true }));
      },
    },
    {
      id: 'stoch-overbought-short',
      name: '스토캐스틱 과매수 숏',
      blurb: 'Stoch K≥80 숏 · RR 1.0',
      gptPrompt: '추천전략 stoch-overbought-short 적용: 스토캐스틱 K≥80 숏만. SL 직전봉 고점, TP 1.0R.',
      build() {
        return pack({
          long: emptyShort(),
          short: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'stoch', params: { kPeriod: 14, dPeriod: 3 }, field: 'k' },
              op: '>=',
              right: { source: 'value', value: 80 },
            }],
          },
        }, rrExit(1.0, { long: false, short: true }), { allowShort: true });
      },
    },
    {
      id: 'ema-golden-long',
      name: 'EMA 골든크로스 롱',
      blurb: 'EMA12>EMA26 골든크로스 · RR 1.2',
      gptPrompt: '추천전략 ema-golden-long 적용: EMA12가 EMA26 상향 돌파 시 롱만. SL 직전봉 저점, TP 1.2R.',
      build() {
        const base = window.StrategyEngine?.goldenCrossPreset?.(12, 26) || {
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'cross_above',
              left: { source: 'indicator', indicator: 'ema', params: { period: 12 }, field: 'value' },
              right: { source: 'indicator', indicator: 'ema', params: { period: 26 }, field: 'value' },
            }],
          },
          short: emptyShort(),
        };
        return pack({
          long: base.long,
          short: emptyShort(),
        }, rrExit(1.2, { long: true }));
      },
    },
    {
      id: 'ema-cross-both',
      name: 'EMA 골든/데드 크로스',
      blurb: 'EMA12/26 양방향 · RR 1.2',
      gptPrompt: '추천전략 ema-cross-both 적용: EMA12/26 골든크로스 롱, 데드크로스 숏. SL 캔들 극단, TP 1.2R.',
      build() {
        const base = window.StrategyEngine?.goldenCrossPreset?.(12, 26);
        return pack(base, rrExit(1.2, { long: true, short: true }), { allowShort: true });
      },
    },
    {
      id: 'hammer-long',
      name: '해머 캔들 롱',
      blurb: '해머 패턴 롱 · RR 1.0',
      gptPrompt: '추천전략 hammer-long 적용: 해머(hammer) 캔들 패턴일 때 롱만. SL 직전봉 저점, TP 1.0R.',
      build() {
        return pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{ type: 'candle_pattern', pattern: 'hammer', offset: 0 }],
          },
          short: emptyShort(),
        }, rrExit(1.0, { long: true }));
      },
    },
    {
      id: 'engulfing-bull-long',
      name: '상승 장악형 롱',
      blurb: '상승 장악 롱 · RR 1.0',
      gptPrompt: '추천전략 engulfing-bull-long 적용: engulfing_bull 패턴 롱만. SL 직전봉 저점, TP 1.0R.',
      build() {
        return pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{ type: 'candle_pattern', pattern: 'engulfing_bull', offset: 0 }],
          },
          short: emptyShort(),
        }, rrExit(1.0, { long: true }));
      },
    },
    {
      id: 'pin-bar-bull-long',
      name: '핀바(롱) 롱',
      blurb: '아랫꼬리 핀바 롱 · RR 1.0',
      gptPrompt: '추천전략 pin-bar-bull-long 적용: pin_bar_bull 패턴 롱만. SL 직전봉 저점, TP 1.0R.',
      build() {
        return pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{ type: 'candle_pattern', pattern: 'pin_bar_bull', offset: 0 }],
          },
          short: emptyShort(),
        }, rrExit(1.0, { long: true }));
      },
    },
    {
      id: 'swing-bounce-long',
      name: '전저점 지지 롱',
      blurb: '스윙 저점 근처 롱 · RR 1.2',
      gptPrompt: '추천전략 swing-bounce-long 적용: 전저점 지지(swing_near long) 롱만. pivotBars 5. SL 직전봉 저점, TP 1.2R.',
      build() {
        return pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'swing_near', side: 'long', pivotBars: 5, lookback: 60, tolerancePct: 0.5,
            }],
          },
          short: emptyShort(),
        }, rrExit(1.2, { long: true }));
      },
    },
    {
      id: 'swing-bounce-both',
      name: '전고저 반등',
      blurb: '전저 지지 롱 / 전고 저항 숏 · RR 1.2',
      gptPrompt: '추천전략 swing-bounce-both 적용: 전저점 지지 롱, 전고점 저항 숏. pivotBars 5, 허용 0.5%. SL 캔들 극단, TP 1.2R.',
      build() {
        return pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'swing_near', side: 'long', pivotBars: 5, lookback: 60, tolerancePct: 0.5,
            }],
          },
          short: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'swing_near', side: 'short', pivotBars: 5, lookback: 60, tolerancePct: 0.5,
            }],
          },
        }, rrExit(1.2, { long: true, short: true }), { allowShort: true });
      },
    },
    {
      id: 'macd-cross-long',
      name: 'MACD 골든크로스 롱',
      blurb: 'MACD>시그널 크로스 롱 · RR 1.2',
      gptPrompt: '추천전략 macd-cross-long 적용: MACD선이 시그널선 상향 돌파 시 롱만. SL 직전봉 저점, TP 1.2R.',
      build() {
        return pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'cross_above',
              left: { source: 'indicator', indicator: 'macd', params: { fast: 12, slow: 26, signal: 9 }, field: 'macd' },
              right: { source: 'indicator', indicator: 'macd', params: { fast: 12, slow: 26, signal: 9 }, field: 'signal' },
            }],
          },
          short: emptyShort(),
        }, rrExit(1.2, { long: true }));
      },
    },
    {
      id: 'rsi-bb-combo-long',
      name: 'RSI+BB 콤보 롱',
      blurb: 'RSI≤35 AND BB 하단 재진입 · RR 1.0',
      gptPrompt: '추천전략 rsi-bb-combo-long 적용: RSI≤35 그리고 볼린저 하단 재진입일 때 롱만. SL 직전봉 저점, TP 1.0R.',
      build() {
        return pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [
              {
                type: 'compare',
                left: { source: 'indicator', indicator: 'rsi', params: { period: 14 }, field: 'value' },
                op: '<=',
                right: { source: 'value', value: 35 },
              },
              {
                type: 'band_reentry', side: 'long', indicator: 'boll',
                params: { period: 20, mult: 2 },
              },
            ],
          },
          short: emptyShort(),
        }, rrExit(1.0, { long: true }));
      },
    },
    {
      id: 'kc-reentry-long',
      name: '켈트너 하단 재진입 롱',
      blurb: 'KC 하단 재진입 · RR 1.2',
      gptPrompt: '추천전략 kc-reentry-long 적용: 켈트너 채널 하단 재진입 롱만. SL 직전봉 저점, TP 1.2R.',
      build() {
        const entry = window.StrategyEngine?.bandReentryPreset?.('kc', 'long', { period: 20, mult: 2 })
          || {
            long: {
              enabled: true,
              logic: 'all',
              conditions: [{
                type: 'band_reentry', side: 'long', indicator: 'kc',
                params: { period: 20, mult: 2 },
              }],
            },
            short: emptyShort(),
          };
        return pack(entry, rrExit(1.2, { long: true }));
      },
    },
    {
      id: 'shooting-star-short',
      name: '슈팅스타 숏',
      blurb: '슈팅스타 패턴 숏 · RR 1.0',
      gptPrompt: '추천전략 shooting-star-short 적용: shooting_star 패턴 숏만. SL 직전봉 고점, TP 1.0R.',
      build() {
        return pack({
          long: emptyShort(),
          short: {
            enabled: true,
            logic: 'all',
            conditions: [{ type: 'candle_pattern', pattern: 'shooting_star', offset: 0 }],
          },
        }, rrExit(1.0, { long: false, short: true }), { allowShort: true });
      },
    },
  ];

  function sanitizeSettings(settings) {
    if (!settings) return null;
    const out = { ...settings };
    if (out.entryRules && window.StrategyEngine?.sanitizeEntryRules) {
      out.entryRules = StrategyEngine.sanitizeEntryRules(out.entryRules);
    }
    if (out.exitRules && window.StrategyEngine?.sanitizeExitRules) {
      out.exitRules = StrategyEngine.sanitizeExitRules(out.exitRules);
    }
    return out;
  }

  function getPreset(id) {
    return CATALOG.find((p) => p.id === id) || null;
  }

  function listCatalog() {
    return CATALOG.map((p) => ({
      id: p.id,
      name: p.name,
      blurb: p.blurb,
      gptPrompt: p.gptPrompt,
    }));
  }

  function measurePreset(candles, preset, { maxTrades = 50 } = {}) {
    const settings = sanitizeSettings(preset.build());
    if (!settings || !window.FuturesStrategy?.runReplay || !candles?.length) {
      return {
        id: preset.id,
        name: preset.name,
        blurb: preset.blurb,
        gptPrompt: preset.gptPrompt,
        settings,
        winRate: 0,
        trades: 0,
        totalPnlPct: 0,
        ok: false,
      };
    }
    const result = FuturesStrategy.runReplay(candles, settings, {
      maxTrades,
      skipMarkers: true,
    });
    const stats = result?.stats || {};
    const trades = stats.trades || 0;
    const winRate = stats.winRate || 0;
    return {
      id: preset.id,
      name: preset.name,
      blurb: preset.blurb,
      gptPrompt: preset.gptPrompt,
      settings,
      winRate: Math.round(winRate * 10) / 10,
      trades,
      wins: stats.wins || 0,
      losses: stats.losses || 0,
      totalPnlPct: Math.round((stats.totalPnlPct || 0) * 10) / 10,
      ok: trades >= 5 && winRate >= 50,
    };
  }

  /**
   * Rank catalog on current candles; return up to `limit` with winRate >= minWinRate.
   * If fewer than limit pass, fill with next-best (still marked ok=false).
   */
  function recommend(candles, { minWinRate = 50, minTrades = 5, limit = 10, maxTrades = 50 } = {}) {
    if (!candles?.length) {
      return { items: [], note: '차트 캔들이 없어 추천할 수 없습니다.', measuredAt: Date.now() };
    }
    const measured = CATALOG.map((p) => measurePreset(candles, p, { maxTrades }));
    const passing = measured
      .filter((m) => m.trades >= minTrades && m.winRate >= minWinRate)
      .sort((a, b) => (b.winRate - a.winRate) || (b.trades - a.trades) || (b.totalPnlPct - a.totalPnlPct));
    const failing = measured
      .filter((m) => !(m.trades >= minTrades && m.winRate >= minWinRate))
      .sort((a, b) => (b.winRate - a.winRate) || (b.trades - a.trades));

    const items = [...passing];
    for (const m of failing) {
      if (items.length >= limit) break;
      items.push(m);
    }
    const top = items.slice(0, limit);
    const passCount = top.filter((m) => m.ok).length;
    const note = passCount >= limit
      ? `현재 차트 기준 승률 ${minWinRate}% 이상 전략 ${passCount}개`
      : passCount > 0
        ? `승률 ${minWinRate}% 이상 ${passCount}개 · 나머지는 차선 후보`
        : `승률 ${minWinRate}% 이상 전략이 부족합니다 · 차선 후보를 표시합니다`;
    return {
      items: top,
      passCount,
      note,
      symbol: null,
      measuredAt: Date.now(),
      minWinRate,
      minTrades,
    };
  }

  function catalogForAi() {
    return CATALOG.map((p) => `${p.id}: ${p.name} — ${p.blurb}`).join('\n');
  }

  window.StrategyPresets = {
    CATALOG,
    listCatalog,
    getPreset,
    sanitizeSettings,
    measurePreset,
    recommend,
    catalogForAi,
  };
})();
