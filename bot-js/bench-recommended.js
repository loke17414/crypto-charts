'use strict';

/**
 * Backtest candidates with RR >= 1:1 (or TP% >= SL%).
 * Select top 10 by positive long-run PnL (not win-rate alone).
 * Writes bot-js/bench-recommended-top10.json
 */

const fs = require('fs');
const path = require('path');
const { buildRuntime } = require('./strategy-runtime');

const SYMBOL = process.env.BENCH_SYMBOL || 'BTCUSDT';
const INTERVALS = (process.env.BENCH_INTERVALS || '15m,1h').split(',').map((s) => s.trim());
const MAX_TRADES = 100;
const MIN_WR = 50;
const MIN_PNL = 0.1; // require net positive cumulative PnL %
const TARGET_CANDLES = 6000;

function empty() {
  return { enabled: false, logic: 'all', conditions: [] };
}

function rrExit(ratio, { long = true, short = false } = {}) {
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

function atrExit(ratio, mult = 1.5, { long = true, short = false } = {}) {
  const out = {};
  if (long) {
    out.long = {
      stopLoss: { type: 'atr', period: 14, mult },
      takeProfit: { type: 'risk_reward', ratio },
    };
  }
  if (short) {
    out.short = {
      stopLoss: { type: 'atr', period: 14, mult },
      takeProfit: { type: 'risk_reward', ratio },
    };
  }
  return out;
}

function pack(entryRules, exitRules, extra = {}) {
  return {
    allowShort: !!(entryRules.short && entryRules.short.enabled),
    entryRules,
    exitRules: exitRules || null,
    ...extra,
  };
}

function buildCandidates(SE) {
  const list = [];
  const add = (id, name, blurb, settings) => {
    list.push({
      id,
      name,
      blurb,
      settings,
      gptPrompt: `추천전략 ${id} 적용: ${blurb}. 설정을 그대로 적용해.`,
    });
  };

  // Fixed % — only TP >= SL (min 1:1)
  const pctPairs = [
    [1, 1], [1.2, 1.2], [1.5, 1.5], [2, 2],
    [1, 1.5], [1, 2], [1.5, 2], [1.5, 2.5], [2, 3],
  ];
  // RR ratios for dynamic exits — min 1.0
  const rrList = [1.0, 1.2, 1.5, 2.0];

  for (const thr of [25, 28, 30, 32, 35]) {
    for (const [sl, tp] of pctPairs) {
      add(
        `rsi-long-${thr}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
        `RSI≤${thr} 롱 (SL${sl}%/TP${tp}%)`,
        `RSI≤${thr} · SL ${sl}% TP ${tp}% (RR≥1)`,
        pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'rsi', params: { period: 14 }, field: 'value' },
              op: '<=',
              right: { source: 'value', value: thr },
            }],
          },
          short: empty(),
        }, null, { stopLossPct: sl, takeProfitPct: tp, useStopLoss: true }),
      );
    }
    for (const rr of rrList) {
      add(
        `rsi-long-${thr}-atr-rr${String(rr).replace('.', '')}`,
        `RSI≤${thr} 롱 (ATR RR${rr})`,
        `RSI≤${thr} · ATR SL · RR ${rr}`,
        pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'rsi', params: { period: 14 }, field: 'value' },
              op: '<=',
              right: { source: 'value', value: thr },
            }],
          },
          short: empty(),
        }, atrExit(rr, 1.5, { long: true })),
      );
    }
  }

  for (const thr of [65, 68, 70, 72, 75]) {
    for (const [sl, tp] of pctPairs) {
      add(
        `rsi-short-${thr}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
        `RSI≥${thr} 숏 (SL${sl}%/TP${tp}%)`,
        `RSI≥${thr} · SL ${sl}% TP ${tp}% (RR≥1)`,
        pack({
          long: empty(),
          short: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'rsi', params: { period: 14 }, field: 'value' },
              op: '>=',
              right: { source: 'value', value: thr },
            }],
          },
        }, null, { allowShort: true, stopLossPct: sl, takeProfitPct: tp, useStopLoss: true }),
      );
    }
  }

  for (const [lo, hi] of [[30, 70], [28, 72], [25, 75]]) {
    for (const [sl, tp] of pctPairs.slice(0, 6)) {
      add(
        `rsi-both-${lo}-${hi}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
        `RSI ${lo}/${hi} 양방향 (SL${sl}%/TP${tp}%)`,
        `RSI 양방향 · SL ${sl}% TP ${tp}%`,
        pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'rsi', params: { period: 14 }, field: 'value' },
              op: '<=',
              right: { source: 'value', value: lo },
            }],
          },
          short: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'rsi', params: { period: 14 }, field: 'value' },
              op: '>=',
              right: { source: 'value', value: hi },
            }],
          },
        }, null, { allowShort: true, stopLossPct: sl, takeProfitPct: tp, useStopLoss: true }),
      );
    }
  }

  for (const ind of ['boll', 'kc', 'env']) {
    for (const side of ['long', 'short']) {
      const entry = SE.bandReentryPreset(
        ind,
        side,
        ind === 'env' ? { period: 20, pct: 0.1 } : { period: 20, mult: 2 },
      );
      for (const rr of rrList) {
        add(
          `${ind}-${side}-atr-rr${String(rr).replace('.', '')}`,
          `${ind.toUpperCase()} ${side === 'long' ? '하단' : '상단'} (ATR RR${rr})`,
          `${ind} ${side} · ATR RR ${rr}`,
          pack(entry, atrExit(rr, 1.5, { long: side === 'long', short: side === 'short' }), {
            allowShort: side === 'short',
          }),
        );
        add(
          `${ind}-${side}-crr${String(rr).replace('.', '')}`,
          `${ind.toUpperCase()} ${side === 'long' ? '하단' : '상단'} (캔들 RR${rr})`,
          `${ind} ${side} · 캔들SL RR ${rr}`,
          pack(entry, rrExit(rr, { long: side === 'long', short: side === 'short' }), {
            allowShort: side === 'short',
          }),
        );
      }
      for (const [sl, tp] of pctPairs.slice(0, 6)) {
        add(
          `${ind}-${side}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
          `${ind.toUpperCase()} ${side === 'long' ? '하단' : '상단'} (SL${sl}%/TP${tp}%)`,
          `${ind} ${side} · SL ${sl}% TP ${tp}%`,
          pack(entry, null, {
            allowShort: side === 'short',
            stopLossPct: sl,
            takeProfitPct: tp,
            useStopLoss: true,
          }),
        );
      }
    }
  }

  for (const thr of [15, 20, 25]) {
    for (const [sl, tp] of pctPairs.slice(0, 6)) {
      add(
        `stoch-long-${thr}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
        `Stoch≤${thr} 롱 (SL${sl}%/TP${tp}%)`,
        `Stoch K≤${thr} · SL ${sl}% TP ${tp}%`,
        pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'stoch', params: { kPeriod: 14, dPeriod: 3 }, field: 'k' },
              op: '<=',
              right: { source: 'value', value: thr },
            }],
          },
          short: empty(),
        }, null, { stopLossPct: sl, takeProfitPct: tp, useStopLoss: true }),
      );
    }
    for (const rr of rrList) {
      add(
        `stoch-long-${thr}-atr-rr${String(rr).replace('.', '')}`,
        `Stoch≤${thr} 롱 (ATR RR${rr})`,
        `Stoch K≤${thr} · ATR RR ${rr}`,
        pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'stoch', params: { kPeriod: 14, dPeriod: 3 }, field: 'k' },
              op: '<=',
              right: { source: 'value', value: thr },
            }],
          },
          short: empty(),
        }, atrExit(rr, 1.5, { long: true })),
      );
    }
  }

  for (const thr of [75, 80, 85]) {
    for (const [sl, tp] of pctPairs.slice(0, 5)) {
      add(
        `stoch-short-${thr}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
        `Stoch≥${thr} 숏 (SL${sl}%/TP${tp}%)`,
        `Stoch K≥${thr} · SL ${sl}% TP ${tp}%`,
        pack({
          long: empty(),
          short: {
            enabled: true,
            logic: 'all',
            conditions: [{
              type: 'compare',
              left: { source: 'indicator', indicator: 'stoch', params: { kPeriod: 14, dPeriod: 3 }, field: 'k' },
              op: '>=',
              right: { source: 'value', value: thr },
            }],
          },
        }, null, { allowShort: true, stopLossPct: sl, takeProfitPct: tp, useStopLoss: true }),
      );
    }
  }

  for (const [pat, side] of [
    ['hammer', 'long'],
    ['engulfing_bull', 'long'],
    ['pin_bar_bull', 'long'],
    ['shooting_star', 'short'],
    ['engulfing_bear', 'short'],
    ['pin_bar_bear', 'short'],
  ]) {
    const isLong = side === 'long';
    for (const rr of rrList) {
      add(
        `${pat}-atr-rr${String(rr).replace('.', '')}`,
        `${pat} ${isLong ? '롱' : '숏'} (ATR RR${rr})`,
        `${pat} · ATR RR ${rr}`,
        pack({
          long: isLong
            ? { enabled: true, logic: 'all', conditions: [{ type: 'candle_pattern', pattern: pat, offset: 0 }] }
            : empty(),
          short: !isLong
            ? { enabled: true, logic: 'all', conditions: [{ type: 'candle_pattern', pattern: pat, offset: 0 }] }
            : empty(),
        }, atrExit(rr, 1.5, { long: isLong, short: !isLong }), { allowShort: !isLong }),
      );
    }
    for (const [sl, tp] of [[1.5, 1.5], [2, 2], [1.5, 2], [2, 3]]) {
      add(
        `${pat}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
        `${pat} ${isLong ? '롱' : '숏'} (SL${sl}%/TP${tp}%)`,
        `${pat} · SL ${sl}% TP ${tp}%`,
        pack({
          long: isLong
            ? { enabled: true, logic: 'all', conditions: [{ type: 'candle_pattern', pattern: pat, offset: 0 }] }
            : empty(),
          short: !isLong
            ? { enabled: true, logic: 'all', conditions: [{ type: 'candle_pattern', pattern: pat, offset: 0 }] }
            : empty(),
        }, null, {
          allowShort: !isLong,
          stopLossPct: sl,
          takeProfitPct: tp,
          useStopLoss: true,
        }),
      );
    }
  }

  for (const [sl, tp] of pctPairs.slice(0, 7)) {
    add(
      `swing-bounce-both-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
      `전고저 반등 (SL${sl}%/TP${tp}%)`,
      `swing_near 양방향 · SL ${sl}% TP ${tp}%`,
      pack({
        long: {
          enabled: true,
          logic: 'all',
          conditions: [{ type: 'swing_near', side: 'long', pivotBars: 5, lookback: 60, tolerancePct: 0.5 }],
        },
        short: {
          enabled: true,
          logic: 'all',
          conditions: [{ type: 'swing_near', side: 'short', pivotBars: 5, lookback: 60, tolerancePct: 0.5 }],
        },
      }, null, { allowShort: true, stopLossPct: sl, takeProfitPct: tp, useStopLoss: true }),
    );
  }

  for (const thr of [30, 35]) {
    for (const [sl, tp] of pctPairs.slice(0, 6)) {
      add(
        `rsi-bb-${thr}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
        `RSI≤${thr}+BB 롱 (SL${sl}%/TP${tp}%)`,
        `RSI+BB · SL ${sl}% TP ${tp}%`,
        pack({
          long: {
            enabled: true,
            logic: 'all',
            conditions: [
              {
                type: 'compare',
                left: { source: 'indicator', indicator: 'rsi', params: { period: 14 }, field: 'value' },
                op: '<=',
                right: { source: 'value', value: thr },
              },
              { type: 'band_reentry', side: 'long', indicator: 'boll', params: { period: 20, mult: 2 } },
            ],
          },
          short: empty(),
        }, null, { stopLossPct: sl, takeProfitPct: tp, useStopLoss: true }),
      );
    }
  }

  for (const [sl, tp] of pctPairs.slice(0, 7)) {
    const gc = SE.goldenCrossPreset(12, 26);
    add(
      `ema-golden-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
      `EMA 골든 롱 (SL${sl}%/TP${tp}%)`,
      `EMA12/26 골든 · SL ${sl}% TP ${tp}%`,
      pack({ long: gc.long, short: empty() }, null, {
        stopLossPct: sl, takeProfitPct: tp, useStopLoss: true,
      }),
    );
    add(
      `ema-both-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
      `EMA 양방향 (SL${sl}%/TP${tp}%)`,
      `EMA12/26 양방향 · SL ${sl}% TP ${tp}%`,
      pack(gc, null, {
        allowShort: true, stopLossPct: sl, takeProfitPct: tp, useStopLoss: true,
      }),
    );
    add(
      `macd-long-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
      `MACD 골든 롱 (SL${sl}%/TP${tp}%)`,
      `MACD cross 롱 · SL ${sl}% TP ${tp}%`,
      pack({
        long: {
          enabled: true,
          logic: 'all',
          conditions: [{
            type: 'cross_above',
            left: { source: 'indicator', indicator: 'macd', params: { fast: 12, slow: 26, signal: 9 }, field: 'macd' },
            right: { source: 'indicator', indicator: 'macd', params: { fast: 12, slow: 26, signal: 9 }, field: 'signal' },
          }],
        },
        short: empty(),
      }, null, { stopLossPct: sl, takeProfitPct: tp, useStopLoss: true }),
    );
  }

  return list;
}

async function fetchKlines(symbol, interval, target) {
  let all = [];
  let endTime;
  while (all.length < target) {
    const params = new URLSearchParams({ symbol, interval, limit: '1500' });
    if (endTime) params.set('endTime', String(endTime));
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?${params}`);
    if (!res.ok) throw new Error(`klines HTTP ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    all = batch.concat(all);
    endTime = batch[0][0] - 1;
    if (batch.length < 1500) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const byTime = new Map();
  for (const k of all) byTime.set(k[0], k);
  return [...byTime.values()]
    .sort((a, b) => a[0] - b[0])
    .map((k) => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
}

function measureAll(FuturesStrategy, StrategyEngine, candles, candidates) {
  const results = [];
  for (const c of candidates) {
    const settings = {
      ...c.settings,
      entryRules: StrategyEngine.sanitizeEntryRules(c.settings.entryRules),
      exitRules: c.settings.exitRules && StrategyEngine.sanitizeExitRules
        ? StrategyEngine.sanitizeExitRules(c.settings.exitRules)
        : c.settings.exitRules,
    };
    const replay = FuturesStrategy.runReplay(candles, settings, {
      maxTrades: MAX_TRADES,
      skipMarkers: true,
    });
    const s = replay.stats || {};
    const trades = s.trades || 0;
    const winRate = s.winRate || 0;
    const totalPnlPct = s.totalPnlPct || 0;
    // Approx expectancy per trade (%), useful for ranking long-run edge
    const expectancy = trades > 0 ? totalPnlPct / trades : 0;
    results.push({
      id: c.id,
      name: c.name,
      blurb: c.blurb,
      gptPrompt: c.gptPrompt,
      settings: c.settings,
      trades,
      winRate: Math.round(winRate * 10) / 10,
      wins: s.wins || 0,
      losses: s.losses || 0,
      totalPnlPct: Math.round(totalPnlPct * 10) / 10,
      expectancy: Math.round(expectancy * 1000) / 1000,
    });
  }
  return results;
}

function rankKey(a, b) {
  // Primary: cumulative PnL, then expectancy, then win rate
  return (b.totalPnlPct - a.totalPnlPct)
    || (b.expectancy - a.expectancy)
    || (b.winRate - a.winRate)
    || (b.trades - a.trades);
}

function isPassing(r) {
  return r.trades >= MAX_TRADES
    && r.winRate >= MIN_WR
    && r.totalPnlPct >= MIN_PNL;
}

async function main() {
  console.log('Loading strategy runtime…');
  console.log(`Filters: trades>=${MAX_TRADES}, WR>=${MIN_WR}%, PnL>=${MIN_PNL}%, RR>=1:1`);
  const { FuturesStrategy, StrategyEngine } = buildRuntime();
  const origWarn = console.warn;
  console.warn = (...args) => {
    if (String(args[0] || '').includes('동적 SL/TP')) return;
    origWarn(...args);
  };

  const candidates = buildCandidates(StrategyEngine);
  console.log(`Candidates: ${candidates.length}`);

  const allPassing = [];
  for (const interval of INTERVALS) {
    console.log(`\n=== ${SYMBOL} ${interval} ===`);
    const candles = await fetchKlines(SYMBOL, interval, TARGET_CANDLES);
    console.log(`Candles: ${candles.length}`);
    const results = measureAll(FuturesStrategy, StrategyEngine, candles, candidates);
    const passing = results.filter(isPassing).sort(rankKey);
    console.log(`Passing (WR+PnL): ${passing.length}`);
    passing.slice(0, 12).forEach((r, i) => {
      console.log(
        `  ${i + 1}. ${r.id} WR=${r.winRate}% PnL=${r.totalPnlPct}% E=${r.expectancy}% n=${r.trades}`,
      );
    });
    for (const r of passing) {
      allPassing.push({ ...r, interval, symbol: SYMBOL });
    }
  }

  const bestById = new Map();
  for (const r of allPassing) {
    const prev = bestById.get(r.id);
    if (!prev || rankKey(prev, r) > 0) bestById.set(r.id, r);
  }

  function familyKey(id) {
    // Collapse exit params + numeric thresholds so rsi-short-65 ≈ rsi-short-68
    return String(id)
      .replace(/-sl[\dp]+-tp[\dp]+$/i, '')
      .replace(/-atr-rr[\d]+$/i, '')
      .replace(/-crr[\d]+$/i, '')
      .replace(/(-\d+(?:p\d+)?)+$/g, '');
  }

  // PnL-first, but keep entry-family diversity (avoid 5 near-identical Stoch shorts).
  function pickTop(pool, n) {
    const ranked = [...pool].sort(rankKey);
    const picked = [];
    const seenFamily = new Set();
    for (const r of ranked) {
      if (picked.length >= n) break;
      const fam = familyKey(r.id);
      if (seenFamily.has(fam)) continue;
      seenFamily.add(fam);
      picked.push(r);
    }
    for (const r of ranked) {
      if (picked.length >= n) break;
      if (picked.some((t) => t.id === r.id)) continue;
      picked.push(r);
    }
    return picked;
  }

  let top10 = pickTop([...bestById.values()], 10);

  if (top10.length < 10) {
    console.warn(`\nOnly ${top10.length} strategies passed WR+PnL filters.`);
    // Soft fill from already-measured pool: relax WR to 45, keep positive PnL
    const softPool = [];
    // Re-measure once more only if needed — reuse allPassing when possible
    for (const interval of INTERVALS) {
      const candles = await fetchKlines(SYMBOL, interval, TARGET_CANDLES);
      const results = measureAll(FuturesStrategy, StrategyEngine, candles, candidates)
        .filter((r) => r.trades >= MAX_TRADES && r.totalPnlPct >= MIN_PNL && r.winRate >= 45)
        .sort(rankKey);
      for (const r of results) softPool.push({ ...r, interval, symbol: SYMBOL });
    }
    const softBest = new Map();
    for (const r of softPool) {
      const prev = softBest.get(r.id);
      if (!prev || rankKey(prev, r) > 0) softBest.set(r.id, r);
    }
    top10 = pickTop([...softBest.values()], 10).map((r) => (
      top10.some((t) => t.id === r.id) ? r : { ...r, note: r.note || 'soft-fill' }
    ));
  }

  // Polish display names for candle patterns
  const NAME_FIX = {
    engulfing_bear: '하락 장악형',
    engulfing_bull: '상승 장악형',
    shooting_star: '유성형',
    hammer: '망치형',
    pin_bar_bear: '핀바 숏',
    pin_bar_bull: '핀바 롱',
  };
  top10 = top10.map((r) => {
    let name = r.name;
    for (const [en, ko] of Object.entries(NAME_FIX)) {
      if (name.startsWith(en)) name = name.replace(en, ko);
    }
    return { ...r, name };
  });

  console.log('\n=== TOP 10 (PnL-first, RR≥1:1) ===');
  top10.forEach((r, i) => {
    console.log(
      `${i + 1}. [${r.interval}] ${r.name} WR=${r.winRate}% PnL=${r.totalPnlPct}% E/trade=${r.expectancy}%`,
    );
  });

  const outPath = path.join(__dirname, 'bench-recommended-top10.json');
  fs.writeFileSync(outPath, JSON.stringify({
    symbol: SYMBOL,
    intervals: INTERVALS,
    maxTrades: MAX_TRADES,
    minWinRate: MIN_WR,
    minPnlPct: MIN_PNL,
    minRiskReward: 1,
    rankBy: 'totalPnlPct > expectancy > winRate',
    measuredAt: new Date().toISOString(),
    items: top10,
  }, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.warn = origWarn;

  if (top10.length < 10) {
    console.error('Failed to find 10 strategies meeting criteria.');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
