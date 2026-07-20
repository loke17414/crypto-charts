'use strict';

/**
 * Backtest a large candidate pool (maxTrades=100) and pick top 10 with WR>=50%.
 * Writes bot-js/bench-recommended-top10.json
 */

const fs = require('fs');
const path = require('path');
const { buildRuntime } = require('./strategy-runtime');

const SYMBOL = process.env.BENCH_SYMBOL || 'BTCUSDT';
const INTERVALS = (process.env.BENCH_INTERVALS || '15m,1h,5m').split(',').map((s) => s.trim());
const MAX_TRADES = 100;
const MIN_WR = 50;
const TARGET_CANDLES = 5000;

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

  // --- Fixed % exits (higher WR when TP < SL) ---
  const pctPairs = [
    [1.5, 1.0], [2.0, 1.0], [2.0, 1.2], [1.2, 0.8], [1.0, 0.6], [2.5, 1.5],
  ];

  for (const thr of [25, 28, 30, 32]) {
    for (const [sl, tp] of pctPairs) {
      add(
        `rsi-long-${thr}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
        `RSI≤${thr} 롱 SL${sl}/TP${tp}`,
        `RSI≤${thr} · 고정 SL ${sl}% TP ${tp}%`,
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
  }

  for (const thr of [68, 70, 72, 75]) {
    for (const [sl, tp] of pctPairs) {
      add(
        `rsi-short-${thr}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
        `RSI≥${thr} 숏 SL${sl}/TP${tp}`,
        `RSI≥${thr} · 고정 SL ${sl}% TP ${tp}%`,
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

  // RSI both with favorable RR (fixed %)
  for (const [lo, hi] of [[30, 70], [28, 72]]) {
    for (const [sl, tp] of [[2, 1], [1.5, 1], [2, 1.2]]) {
      add(
        `rsi-both-${lo}-${hi}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
        `RSI ${lo}/${hi} 양방향 SL${sl}/TP${tp}`,
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

  // Band reentry + low RR (candle / ATR)
  for (const ind of ['boll', 'kc', 'env']) {
    for (const side of ['long', 'short']) {
      for (const rr of [0.5, 0.6, 0.7, 0.8, 1.0]) {
        const entry = SE.bandReentryPreset(
          ind,
          side,
          ind === 'env' ? { period: 20, pct: 0.1 } : { period: 20, mult: 2 },
        );
        add(
          `${ind}-${side}-crr${String(rr).replace('.', '')}`,
          `${ind.toUpperCase()} ${side === 'long' ? '하단' : '상단'} RR${rr}`,
          `${ind} ${side} · 캔들SL RR ${rr}`,
          pack(entry, rrExit(rr, { long: side === 'long', short: side === 'short' }), {
            allowShort: side === 'short',
          }),
        );
        add(
          `${ind}-${side}-atr-rr${String(rr).replace('.', '')}`,
          `${ind.toUpperCase()} ${side === 'long' ? '하단' : '상단'} ATR RR${rr}`,
          `${ind} ${side} · ATR SL RR ${rr}`,
          pack(entry, atrExit(rr, 1.5, { long: side === 'long', short: side === 'short' }), {
            allowShort: side === 'short',
          }),
        );
      }
    }
  }

  // Band + fixed %
  for (const ind of ['boll', 'kc']) {
    for (const side of ['long', 'short']) {
      for (const [sl, tp] of [[1.5, 1], [2, 1], [2, 1.2], [1.2, 0.8]]) {
        const entry = SE.bandReentryPreset(ind, side, { period: 20, mult: 2 });
        add(
          `${ind}-${side}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
          `${ind.toUpperCase()} ${side === 'long' ? '하단' : '상단'} SL${sl}/TP${tp}`,
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

  // Stoch fixed %
  for (const thr of [20, 25]) {
    for (const [sl, tp] of [[2, 1], [1.5, 1], [2, 1.2]]) {
      add(
        `stoch-long-${thr}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
        `Stoch≤${thr} 롱 SL${sl}/TP${tp}`,
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
  }

  // Patterns + low RR ATR
  for (const [pat, side] of [
    ['hammer', 'long'],
    ['engulfing_bull', 'long'],
    ['pin_bar_bull', 'long'],
    ['shooting_star', 'short'],
    ['engulfing_bear', 'short'],
  ]) {
    for (const rr of [0.5, 0.7, 1.0]) {
      const isLong = side === 'long';
      add(
        `${pat}-atr-rr${String(rr).replace('.', '')}`,
        `${pat} ${isLong ? '롱' : '숏'} ATR RR${rr}`,
        `${pat} · ATR RR ${rr}`,
        pack({
          long: isLong
            ? { enabled: true, logic: 'all', conditions: [{ type: 'candle_pattern', pattern: pat, offset: 0 }] }
            : empty(),
          short: !isLong
            ? { enabled: true, logic: 'all', conditions: [{ type: 'candle_pattern', pattern: pat, offset: 0 }] }
            : empty(),
        }, atrExit(rr, 1.2, { long: isLong, short: !isLong }), { allowShort: !isLong }),
      );
    }
  }

  // Swing + fixed %
  for (const [sl, tp] of [[2, 1], [1.5, 1], [2, 1.2]]) {
    add(
      `swing-bounce-both-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
      `전고저 반등 SL${sl}/TP${tp}`,
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

  // RSI + BB combo fixed %
  for (const thr of [30, 35]) {
    for (const [sl, tp] of [[2, 1], [1.5, 1]]) {
      add(
        `rsi-bb-${thr}-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
        `RSI≤${thr}+BB 롱 SL${sl}/TP${tp}`,
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

  // EMA / MACD with TP < SL
  for (const [sl, tp] of [[2, 1], [1.5, 1], [2.5, 1.5]]) {
    const gc = SE.goldenCrossPreset(12, 26);
    add(
      `ema-golden-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
      `EMA 골든 롱 SL${sl}/TP${tp}`,
      `EMA12/26 골든 · SL ${sl}% TP ${tp}%`,
      pack({ long: gc.long, short: empty() }, null, {
        stopLossPct: sl, takeProfitPct: tp, useStopLoss: true,
      }),
    );
    add(
      `ema-both-sl${sl}-tp${tp}`.replace(/\./g, 'p'),
      `EMA 양방향 SL${sl}/TP${tp}`,
      `EMA12/26 양방향 · SL ${sl}% TP ${tp}%`,
      pack(gc, null, {
        allowShort: true, stopLossPct: sl, takeProfitPct: tp, useStopLoss: true,
      }),
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
    results.push({
      id: c.id,
      name: c.name,
      blurb: c.blurb,
      gptPrompt: c.gptPrompt,
      settings: c.settings,
      trades: s.trades || 0,
      winRate: Math.round((s.winRate || 0) * 10) / 10,
      wins: s.wins || 0,
      losses: s.losses || 0,
      totalPnlPct: Math.round((s.totalPnlPct || 0) * 10) / 10,
    });
  }
  return results;
}

async function main() {
  console.log('Loading strategy runtime…');
  const { FuturesStrategy, StrategyEngine } = buildRuntime();
  // Silence dynamic fallback spam
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
    const passing = results
      .filter((r) => r.trades >= MAX_TRADES && r.winRate >= MIN_WR)
      .sort((a, b) => (b.winRate - a.winRate) || (b.totalPnlPct - a.totalPnlPct));
    console.log(`Passing: ${passing.length}`);
    passing.slice(0, 15).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.id} WR=${r.winRate}% n=${r.trades} pnl=${r.totalPnlPct}%`);
    });
    for (const r of passing) {
      allPassing.push({ ...r, interval, symbol: SYMBOL });
    }
  }

  // Deduplicate by id — keep best WR across intervals
  const bestById = new Map();
  for (const r of allPassing) {
    const prev = bestById.get(r.id);
    if (!prev || r.winRate > prev.winRate
      || (r.winRate === prev.winRate && r.totalPnlPct > prev.totalPnlPct)) {
      bestById.set(r.id, r);
    }
  }
  let top10 = [...bestById.values()]
    .sort((a, b) => (b.winRate - a.winRate) || (b.totalPnlPct - a.totalPnlPct))
    .slice(0, 10);

  if (top10.length < 10) {
    console.warn(`\nOnly ${top10.length} unique strategies with WR>=${MIN_WR}% @ ${MAX_TRADES} trades.`);
    // Fall back: best across last interval even if under threshold, but prefer high WR
    const lastInterval = INTERVALS[0];
    const candles = await fetchKlines(SYMBOL, lastInterval, TARGET_CANDLES);
    const results = measureAll(FuturesStrategy, StrategyEngine, candles, candidates)
      .filter((r) => r.trades >= 80)
      .sort((a, b) => (b.winRate - a.winRate) || (b.totalPnlPct - a.totalPnlPct));
    for (const r of results) {
      if (top10.length >= 10) break;
      if (top10.some((t) => t.id === r.id)) continue;
      top10.push({ ...r, interval: lastInterval, symbol: SYMBOL, note: 'fallback' });
    }
  }

  console.log('\n=== TOP 10 ===');
  top10.forEach((r, i) => {
    console.log(
      `${i + 1}. [${r.interval}] ${r.name} WR=${r.winRate}% n=${r.trades} pnl=${r.totalPnlPct}%`,
    );
  });

  const outPath = path.join(__dirname, 'bench-recommended-top10.json');
  fs.writeFileSync(outPath, JSON.stringify({
    symbol: SYMBOL,
    intervals: INTERVALS,
    maxTrades: MAX_TRADES,
    minWinRate: MIN_WR,
    measuredAt: new Date().toISOString(),
    items: top10,
  }, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.warn = origWarn;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
