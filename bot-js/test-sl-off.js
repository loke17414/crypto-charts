/* Smoke test: stop-loss disabled (useStopLoss: false) must not crash
 * checkExitBar/checkExit/analyze/backtest with null stopPrice.
 * Run: node bot-js/test-sl-off.js — deletable after verification. */
const { buildRuntime } = require('./strategy-runtime');

const { FuturesStrategy } = buildRuntime();

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL: ${label} ${detail}`);
  }
}

const settings = { stopLossPct: 1.5, takeProfitPct: 3, useStopLoss: false };
const entry = 100;

// 1. TP wick hit with SL off — used to crash on stopPrice.toFixed(2).
let exit;
try {
  exit = FuturesStrategy.checkExitBar('LONG', entry, {
    time: 1, open: 100, high: 103.4, low: 95, close: 100.1,
  }, settings);
  check('SL off: TP hit exits without crash', exit && Math.abs(exit.exitPrice - 103) < 1e-9, JSON.stringify(exit));
} catch (e) {
  check('SL off: TP hit exits without crash', false, e.message);
}

// 2. Deep drop below the would-be SL must NOT exit when SL is off.
try {
  exit = FuturesStrategy.checkExitBar('LONG', entry, {
    time: 2, open: 100, high: 100.5, low: 90, close: 91,
  }, settings);
  check('SL off: SL-level drop does not exit', exit == null, JSON.stringify(exit));
} catch (e) {
  check('SL off: SL-level drop does not exit', false, e.message);
}

// 3. checkExit (close-based) with SL off.
try {
  exit = FuturesStrategy.checkExit('LONG', entry, 90, settings);
  check('SL off: checkExit ignores SL', exit == null, JSON.stringify(exit));
  exit = FuturesStrategy.checkExit('LONG', entry, 103.5, settings);
  check('SL off: checkExit still takes TP', exit != null, JSON.stringify(exit));
} catch (e) {
  check('SL off: checkExit', false, e.message);
}

// 4. calcEntryLevels strips SL; analyze label must not crash.
const levels = FuturesStrategy.calcEntryLevels('LONG', entry, settings);
check('SL off: levels.stopPrice is null', levels && levels.stopPrice == null, JSON.stringify(levels));
check('SL off: levels.takeProfitPrice set', levels && Math.abs(levels.takeProfitPrice - 103) < 1e-9, JSON.stringify(levels));

// 5. Full backtest with SL off must complete without throwing.
function makeCandles(n) {
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 7) * 1.2 + (i % 11 === 0 ? 2.5 : 0);
    const open = price;
    const close = price + drift * 0.4;
    out.push({
      time: 1700000000 + i * 3600,
      open,
      close,
      high: Math.max(open, close) + 1.5,
      low: Math.min(open, close) - 1.5,
      volume: 1000,
    });
    price = close;
  }
  return out;
}

try {
  const result = FuturesStrategy.backtest(makeCandles(300), {
    ...settings,
    emaFast: 5,
    emaSlow: 20,
  });
  check('SL off: backtest completes', result && result.stats != null, JSON.stringify(result?.stats));
} catch (e) {
  check('SL off: backtest completes', false, e.message);
}

process.exit(failures ? 1 : 0);
