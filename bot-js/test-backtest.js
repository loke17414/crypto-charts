/* Smoke test: segment backtest engine reaches stable trade counts.
 * Run: node bot-js/test-backtest.js */
const { buildRuntime } = require('./strategy-runtime');

const { FuturesStrategy } = buildRuntime();

function candle(time, close, spread = 0.5) {
  return {
    time,
    open: close,
    high: close + spread,
    low: close - spread,
    close,
    volume: 100,
  };
}

const rsiRules = {
  long: {
    enabled: true,
    logic: 'all',
    conditions: [{
      type: 'compare',
      left: { source: 'indicator', indicator: 'rsi', params: { period: 14 }, field: 'value' },
      op: '<=',
      right: { source: 'value', value: 35 },
    }],
  },
  short: { enabled: false, logic: 'all', conditions: [] },
};

const settings = { stopLossPct: 1.5, takeProfitPct: 3, entryRules: rsiRules };

function buildOscillatingCandles(count, barSec = 3600) {
  const out = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const wave = Math.sin(i / 8) * 4;
    const dip = i % 17 === 0 ? -6 : 0;
    price = Math.max(50, price + wave * 0.3 + dip + (i % 3 === 0 ? -0.4 : 0.2));
    out.push(candle(1700000000 + i * barSec, price));
  }
  return out;
}

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`PASS: ${label}`);
  else { failures += 1; console.log(`FAIL: ${label}`); }
}

// 1. Small window — engine must not throw.
const small = buildOscillatingCandles(400);
let btSmall;
try {
  btSmall = FuturesStrategy.backtest(small, settings, { maxTrades: 10 });
} catch (err) {
  failures += 1;
  console.log(`FAIL: small backtest throws — ${err.message}`);
  btSmall = { stats: { trades: 0, totalTrades: 0 } };
}
check('small backtest completes', Number.isFinite(btSmall.stats.trades));

// 2. Extending history must not shrink kept trade count (segment stability).
const partial = buildOscillatingCandles(1200);
const full = buildOscillatingCandles(2400);
const btPartial = FuturesStrategy.backtest(partial, settings, { maxTrades: 100 });
const btFull = FuturesStrategy.backtest(full, settings, { maxTrades: 100 });
check(
  `extended history does not shrink trades (${btPartial.stats.trades} → ${btFull.stats.trades})`,
  btFull.stats.trades >= btPartial.stats.trades,
);

// 3. maxTrades cap respected.
check('maxTrades caps result', btFull.stats.trades <= 100);

// 4. Stats fields present.
check('targetReached is boolean', typeof btFull.stats.targetReached === 'boolean');
check('rangeFromTime set when trades exist', btFull.stats.trades === 0 || btFull.stats.rangeFromTime != null);

process.exit(failures ? 1 : 0);
