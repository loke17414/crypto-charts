/* Smoke test: multi-slot entry conditions in the shared strategy engine.
 * Run: node bot-js/test-slots.js — deletable after verification. */
const { buildRuntime } = require('./strategy-runtime');

const { FuturesStrategy, StrategyEngine } = buildRuntime();

function candle(time, open, high, low, close) {
  return { time, open, high, low, close, volume: 100 };
}

// 60 flat candles, then a dip that pushes RSI down (slot A) while slot B (EMA cross) stays quiet.
const candles = [];
let price = 100;
for (let i = 0; i < 80; i++) {
  const drop = i > 80 - 8 ? 1.2 : 0;
  const next = price - drop + (i % 2 === 0 ? 0.05 : -0.05);
  candles.push(candle(1700000000 + i * 3600, price, Math.max(price, next) + 0.1, Math.min(price, next) - 0.1, next));
  price = next;
}

const rsiRules = {
  long: {
    enabled: true,
    logic: 'all',
    conditions: [{
      type: 'compare',
      left: { source: 'indicator', indicator: 'rsi', params: { period: 14 }, field: 'value' },
      op: '<=',
      right: { source: 'value', value: 40 },
    }],
  },
  short: { enabled: false, logic: 'all', conditions: [] },
};

const emaCrossRules = {
  long: {
    enabled: true,
    logic: 'all',
    conditions: [{
      type: 'cross_above',
      left: { source: 'indicator', indicator: 'ema', params: { period: 12 }, field: 'value' },
      right: { source: 'indicator', indicator: 'ema', params: { period: 26 }, field: 'value' },
    }],
  },
  short: { enabled: false, logic: 'all', conditions: [] },
};

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL: ${label}`);
  }
}

// 1. Slot matches → signal fires with slot name.
const settings1 = {
  stopLossPct: 1.5,
  takeProfitPct: 3,
  strategySlots: [
    { id: 'a', name: 'RSI 딥', enabled: true, entryRules: rsiRules },
    { id: 'b', name: 'EMA 크로스', enabled: true, entryRules: emaCrossRules },
  ],
};
const r1 = StrategyEngine.evaluateEntry(candles, settings1, null);
check('enabled RSI slot fires LONG', r1.matched === 'LONG');
check('matched slot name reported', r1.slotName === 'RSI 딥');

// 2. Same rules but slot disabled → no signal.
const settings2 = {
  ...settings1,
  strategySlots: [
    { id: 'a', name: 'RSI 딥', enabled: false, entryRules: rsiRules },
    { id: 'b', name: 'EMA 크로스', enabled: true, entryRules: emaCrossRules },
  ],
};
const r2 = StrategyEngine.evaluateEntry(candles, settings2, null);
check('disabled slot does not fire', r2.matched === null);

// 3. All slots off → no entries at all (no RSI preset fallback).
const settings3 = { ...settings1, strategySlots: [{ id: 'a', name: 'x', enabled: false, entryRules: rsiRules }] };
const r3 = StrategyEngine.evaluateEntry(candles, settings3, null);
check('all slots off → wait', r3.matched === null && r3.reason.includes('진입 조건 없음'));

// 4. No strategySlots → legacy entryRules still work.
const settings4 = { stopLossPct: 1.5, takeProfitPct: 3, entryRules: rsiRules };
const r4 = StrategyEngine.evaluateEntry(candles, settings4, null);
check('legacy single entryRules fires', r4.matched === 'LONG');

// 5. Per-slot exitRules override the % SL/TP in analyze().
const settings5 = {
  stopLossPct: 1.5,
  takeProfitPct: 3,
  strategySlots: [{
    id: 'a',
    name: 'RSI 딥',
    enabled: true,
    entryRules: rsiRules,
    exitRules: {
      long: {
        stopLoss: { type: 'atr', period: 14, mult: 1.5 },
        takeProfit: { type: 'risk_reward', ratio: 2 },
      },
    },
  }],
};
const r5 = FuturesStrategy.analyze(candles, settings5, null);
check('analyze fires with slot', r5.signal === 'LONG');
check('slot exitRules produce dynamic levels', Boolean(r5.entryLevels?.dynamic));

// 6. Backtest runs across slots and tags trades with slot names.
const bt = FuturesStrategy.backtest(candles, settings1, {});
check('backtest completes with slots', Number.isFinite(bt.stats.trades));
const named = bt.trades.every((t) => t.slotName === 'RSI 딥' || t.slotName === 'EMA 크로스');
check(`backtest trades carry slot names (${bt.trades.length} trades)`, bt.trades.length === 0 || named);

process.exit(failures ? 1 : 0);
