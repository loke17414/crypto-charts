'use strict';

const { buildRuntime } = require('./strategy-runtime');
const { RiskSizing } = buildRuntime();

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) console.log(`PASS: ${label}`);
  else {
    failures += 1;
    console.log(`FAIL: ${label} ${detail}`);
  }
}

const equity = 10000;
const risk = { riskPerTradePct: 1, leverage: 5 };

// Wider SL → smaller margin for same 1% account risk.
const tight = { stopLossPct: 0.5 };
const wide = { stopLossPct: 2.5 };
const mTight = RiskSizing.calcTradeMarginForEntry(equity, risk, tight);
const mWide = RiskSizing.calcTradeMarginForEntry(equity, risk, wide);
check('tighter SL uses larger margin', mTight > mWide, `tight=${mTight} wide=${mWide}`);

// Entry levels win over global fallback.
const levels = { stopLossPct: 0.8 };
const mLevels = RiskSizing.calcTradeMarginForEntry(equity, { ...risk, stopLossPct: 1.5 }, levels);
const mFallback = RiskSizing.calcTradeMargin(equity, { ...risk, stopLossPct: 1.5 });
check('levels.stopLossPct overrides fallback', mLevels > mFallback, `levels=${mLevels} fallback=${mFallback}`);

// Loss at SL ≈ 1% of equity.
const slPct = RiskSizing.resolveStopLossPctForSizing(levels, 1.5);
const loss = RiskSizing.estimateLossAtSl(mLevels, risk.leverage, slPct);
check('loss at SL near 1% equity', Math.abs(loss - 100) < 1, `loss=${loss}`);

process.exit(failures ? 1 : 0);
