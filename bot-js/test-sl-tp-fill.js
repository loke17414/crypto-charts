'use strict';

const { shiftLevelsToFill, validateSlTp } = require('./sl-tp-utils');

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) console.log(`PASS: ${label}`);
  else {
    failures += 1;
    console.log(`FAIL: ${label} ${detail}`);
  }
}

// LONG: fill above signal — old TP would be below mark and fire immediately.
const longLevels = {
  stopPrice: 98.5,
  takeProfitPrice: 103,
  stopLossPct: 1.5,
  takeProfitPct: 3,
};
const shiftedLong = shiftLevelsToFill('LONG', 100, 105, longLevels);
check('LONG shift SL below fill', shiftedLong.stopPrice === 103.5, JSON.stringify(shiftedLong));
check('LONG shift TP above fill', shiftedLong.takeProfitPrice === 108, JSON.stringify(shiftedLong));
check(
  'LONG shifted SL safe vs mark',
  validateSlTp('LONG', 105, shiftedLong.stopPrice, shiftedLong.takeProfitPrice, 105).length === 0,
  validateSlTp('LONG', 105, shiftedLong.stopPrice, shiftedLong.takeProfitPrice, 105).join('; '),
);
check(
  'unshifted LONG SL unsafe vs mark',
  validateSlTp('LONG', 105, longLevels.stopPrice, longLevels.takeProfitPrice, 105).length > 0,
);

// SHORT: fill below signal.
const shortLevels = { stopPrice: 101.5, takeProfitPrice: 97, stopLossPct: 1.5, takeProfitPct: 3 };
const shiftedShort = shiftLevelsToFill('SHORT', 100, 95, shortLevels);
check('SHORT shift SL above fill', shiftedShort.stopPrice === 96.5, JSON.stringify(shiftedShort));
check('SHORT shift TP below fill', shiftedShort.takeProfitPrice === 92, JSON.stringify(shiftedShort));

process.exit(failures ? 1 : 0);
