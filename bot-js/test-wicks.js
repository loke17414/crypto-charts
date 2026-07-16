/* Smoke test: wick (high/low) handling in bar exits.
 * Run: node bot-js/test-wicks.js ? deletable after verification. */
const { buildRuntime } = require('./strategy-runtime');

const { FuturesStrategy } = buildRuntime();

const approx = (a, b) => Math.abs(a - b) < 1e-9;

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL: ${label} ${detail}`);
  }
}

const settings = { stopLossPct: 1.5, takeProfitPct: 3 };
const entry = 100;
// LONG: SL 98.5, TP 103

// 1. Wick-only SL touch (close recovers above the stop) must exit at the stop.
let exit = FuturesStrategy.checkExitBar('LONG', entry, {
  time: 1, open: 100, high: 100.5, low: 98.0, close: 100.2,
}, settings);
check('LONG wick low hits SL, exit at stop price', exit && approx(exit.exitPrice, 98.5), JSON.stringify(exit));

// 2. Wick-only TP touch (close falls back) must exit at the TP.
exit = FuturesStrategy.checkExitBar('LONG', entry, {
  time: 2, open: 100, high: 103.4, low: 99.8, close: 100.1,
}, settings);
check('LONG wick high hits TP, exit at TP price', exit && approx(exit.exitPrice, 103), JSON.stringify(exit));

// 3. Gap below the stop fills at the open (worse than the trigger), not the stop.
exit = FuturesStrategy.checkExitBar('LONG', entry, {
  time: 3, open: 97, high: 97.5, low: 96, close: 97.2,
}, settings);
check('LONG gap-down SL fills at open', exit && approx(exit.exitPrice, 97), JSON.stringify(exit));

// 4. Both levels wicked in one bar: open near the STOP ? stop assumed first.
exit = FuturesStrategy.checkExitBar('LONG', entry, {
  time: 4, open: 98.7, high: 103.5, low: 98.2, close: 101,
}, settings);
check('both hit, open near SL -> SL first', exit && approx(exit.exitPrice, 98.5), JSON.stringify(exit));

// 5. Both levels wicked in one bar: open near the TP ? TP assumed first.
exit = FuturesStrategy.checkExitBar('LONG', entry, {
  time: 5, open: 102.8, high: 103.5, low: 98.2, close: 101,
}, settings);
check('both hit, open near TP -> TP first', exit && approx(exit.exitPrice, 103), JSON.stringify(exit));

// 6. SHORT: SL 101.5, TP 97. Wick high stops out.
exit = FuturesStrategy.checkExitBar('SHORT', entry, {
  time: 6, open: 100, high: 101.8, low: 99.7, close: 100.1,
}, settings);
check('SHORT wick high hits SL, exit at stop price', exit && approx(exit.exitPrice, 101.5), JSON.stringify(exit));

// 7. SHORT gap above the stop fills at open.
exit = FuturesStrategy.checkExitBar('SHORT', entry, {
  time: 7, open: 102.5, high: 103, low: 102, close: 102.6,
}, settings);
check('SHORT gap-up SL fills at open', exit && approx(exit.exitPrice, 102.5), JSON.stringify(exit));

// 8. No touch ? no exit.
exit = FuturesStrategy.checkExitBar('LONG', entry, {
  time: 8, open: 100, high: 101, low: 99.5, close: 100.5,
}, settings);
check('no touch -> null', exit === null);

process.exit(failures ? 1 : 0);
