'use strict';

const { buildRuntime } = require('./strategy-runtime');
const RS = buildRuntime().RiskSizing;

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) console.log(`PASS: ${label}`);
  else {
    failures += 1;
    console.log(`FAIL: ${label} ${detail}`);
  }
}

// User examples (1회 리스크 2% 설정 시)
const ex1 = RS.calcTradeMargin(5000, { riskPerTradePct: 2, leverage: 5, stopLossPct: 0.4 });
check('ex1 margin $5000 @2% risk', ex1 === 5000, `got ${ex1}`);
const loss1 = RS.estimateLossAtSl(ex1, 5, 0.4);
check('ex1 loss $100 (2% of 5000)', Math.abs(loss1 - 100) < 0.01, `loss=${loss1}`);

const ex2 = RS.calcTradeMargin(8000, { riskPerTradePct: 2, leverage: 5, stopLossPct: 0.8 });
check('ex2 margin $4000 @2% risk', ex2 === 4000, `got ${ex2}`);
const loss2 = RS.estimateLossAtSl(ex2, 5, 0.8);
check('ex2 loss $160 (2% of 8000)', Math.abs(loss2 - 160) < 0.01, `loss=${loss2}`);

// 1% risk (UI 기본값)
const ex1r1 = RS.calcTradeMargin(5000, { riskPerTradePct: 1, leverage: 5, stopLossPct: 0.4 });
check('ex1 margin $2500 @1% risk', ex1r1 === 2500, `got ${ex1r1}`);

const plan = RS.summarizeRiskPlan(8000, { riskPerTradePct: 2, leverage: 5, stopLossPct: 1.5 }, { stopLossPct: 0.8 });
check('summarize uses entry SL%', plan.margin === 4000, JSON.stringify(plan));
check('summarize target loss', Math.abs(plan.targetLoss - 160) < 0.01, `target=${plan.targetLoss}`);

process.exit(failures ? 1 : 0);
