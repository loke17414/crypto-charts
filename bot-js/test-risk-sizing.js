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

const FEE = RS.TRADING_FEE_PCT;
check('fee constant 0.1%', FEE === 0.1, `got ${FEE}`);

// With fee: effective SL = raw SL + 0.1
// User examples (1회 리스크 2% 설정 시) — sized so loss+fee hits risk target
const ex1 = RS.calcTradeMargin(5000, { riskPerTradePct: 2, leverage: 5, stopLossPct: 0.4 });
check('ex1 margin $4000 @2% risk (SL 0.4+fee 0.1)', ex1 === 4000, `got ${ex1}`);
const loss1 = RS.estimateLossAtSl(ex1, 5, 0.4);
check('ex1 loss $100 incl fee (2% of 5000)', Math.abs(loss1 - 100) < 0.01, `loss=${loss1}`);

const ex2 = RS.calcTradeMargin(8000, { riskPerTradePct: 2, leverage: 5, stopLossPct: 0.8 });
check('ex2 margin $3555.56 @2% risk (SL 0.8+fee 0.1)', Math.abs(ex2 - 3555.56) < 0.01, `got ${ex2}`);
const loss2 = RS.estimateLossAtSl(ex2, 5, 0.8);
check('ex2 loss $160 incl fee (2% of 8000)', Math.abs(loss2 - 160) < 0.01, `loss=${loss2}`);

// 1% risk (UI 기본값)
const ex1r1 = RS.calcTradeMargin(5000, { riskPerTradePct: 1, leverage: 5, stopLossPct: 0.4 });
check('ex1 margin $2000 @1% risk (with fee)', ex1r1 === 2000, `got ${ex1r1}`);

const plan = RS.summarizeRiskPlan(8000, { riskPerTradePct: 2, leverage: 5, stopLossPct: 1.5 }, { stopLossPct: 0.8 });
check('summarize uses entry SL% + fee', Math.abs(plan.margin - 3555.56) < 0.01, JSON.stringify(plan));
check('summarize target loss', Math.abs(plan.targetLoss - 160) < 0.01, `target=${plan.targetLoss}`);
check('summarize feePct', plan.feePct === 0.1, `fee=${plan.feePct}`);

// RR distance: ratio 1.5, entry 100, risk 1 → fee 0.1 → dist = 1.5*(1+0.1)+0.1 = 1.75
const dist = RS.takeProfitDistanceForRiskReward(100, 1, 1.5);
check('RR TP distance includes fee', Math.abs(dist - 1.75) < 1e-9, `dist=${dist}`);

process.exit(failures ? 1 : 0);
