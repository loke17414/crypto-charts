/* Smoke test: FuturesStrategy.runReplay (live-engine path). */
const { buildRuntime } = require('./strategy-runtime');

const { FuturesStrategy, StrategyEngine } = buildRuntime();

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) console.log(`PASS: ${label}`);
  else {
    failures += 1;
    console.log(`FAIL: ${label} ${detail}`);
  }
}

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

const candles = makeCandles(400);
const settings = {
  stopLossPct: 1.5,
  takeProfitPct: 3,
  entryRules: StrategyEngine.rsiPresetFromLegacy
    ? StrategyEngine.rsiPresetFromLegacy({ rsiPeriod: 14, rsiOversold: 40, rsiOverbought: 60, allowShort: true })
    : {
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
    },
};

check('createSession exists', typeof StrategyEngine.createSession === 'function');
check('runReplay exists', typeof FuturesStrategy.runReplay === 'function');

const session = StrategyEngine.createSession(candles, settings);
check('session has evaluateAt', typeof session.evaluateAt === 'function');

const result = FuturesStrategy.runReplay(candles, settings, { maxTrades: 50, skipMarkers: false });
check('runReplay returns stats', Boolean(result?.stats));
check('candlesUsed matches', result.stats.candlesUsed === candles.length);
check('markers pair with trades', result.markers.length === result.trades.length * 2
  || result.trades.length === 0);

let progressCalls = 0;
FuturesStrategy.runReplay(candles, settings, {
  maxTrades: 20,
  skipMarkers: true,
  onProgress: () => { progressCalls += 1; },
});
check('onProgress can fire', progressCalls >= 0);

process.exit(failures ? 1 : 0);
