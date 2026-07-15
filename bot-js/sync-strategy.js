'use strict';

/*
 * Syncs the browser strategy files (js/*.js) into the bot's OWN snapshot
 * directory (bot-js/strategy/) — but only after the candidate code passes a
 * validation gate. The bot loads exclusively from the snapshot, so a broken
 * or half-edited js/ tree can never take the running bot down; the bot simply
 * keeps trading on the last known-good strategy code.
 *
 * Entry rules are NOT affected: they live in strategy.json (exported from the
 * trading UI) and are read by the bot at startup as before.
 *
 * Run: node bot-js/sync-strategy.js
 * Exit code 0 = snapshot updated (or already up to date)
 * Exit code 1 = validation failed, existing snapshot left untouched
 */

const fs = require('fs');
const path = require('path');

const { buildRuntime, LOAD_ORDER } = require('./strategy-runtime');

const SOURCE_DIR = path.join(__dirname, '..', 'js');
const SNAPSHOT_DIR = path.join(__dirname, 'strategy');

function log(msg) {
  console.log(`[sync-strategy] ${msg}`);
}

// ---- Validation gate ------------------------------------------------------
// Exercises the code paths the bot actually uses (analyze / checkExit /
// checkExitBar / backtest), including the configurations that broke before
// (stop-loss disabled, entry slots with dynamic exit rules).
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

function validate(dir) {
  const errors = [];
  let brain;
  try {
    brain = buildRuntime(dir);
  } catch (err) {
    return [`runtime build failed: ${err.message}`];
  }
  const { FuturesStrategy, StrategyEngine } = brain;
  const candles = makeCandles(300);

  const scenarios = [
    { name: 'default', settings: { stopLossPct: 1.5, takeProfitPct: 3, emaFast: 5, emaSlow: 20 } },
    { name: 'SL off', settings: { stopLossPct: 1.5, takeProfitPct: 3, emaFast: 5, emaSlow: 20, useStopLoss: false } },
    {
      name: 'slots + dynamic exit',
      settings: {
        stopLossPct: 1.5,
        takeProfitPct: 3,
        strategySlots: [{
          id: 's1',
          name: 'test',
          enabled: true,
          rules: { long: [{ type: 'rsi_below', value: 70 }], short: [] },
          exitRules: {
            long: { stopLoss: { type: 'candle_extreme', offset: 1, field: 'low' }, takeProfit: { type: 'risk_reward', ratio: 1.5 } },
          },
        }],
      },
    },
  ];

  for (const { name, settings } of scenarios) {
    try {
      const r = FuturesStrategy.analyze(candles, settings, null);
      if (!r || typeof r.signal !== 'string') errors.push(`[${name}] analyze returned invalid result`);
    } catch (err) {
      errors.push(`[${name}] analyze threw: ${err.message}`);
    }
    try {
      const bt = FuturesStrategy.backtest(candles, settings);
      if (!bt || !bt.stats) errors.push(`[${name}] backtest returned invalid result`);
    } catch (err) {
      errors.push(`[${name}] backtest threw: ${err.message}`);
    }
    try {
      FuturesStrategy.checkExit('LONG', 100, 103.5, settings);
      FuturesStrategy.checkExitBar('LONG', 100, { time: 1, open: 100, high: 103.4, low: 95, close: 101 }, settings);
    } catch (err) {
      errors.push(`[${name}] exit check threw: ${err.message}`);
    }
  }

  try {
    if (StrategyEngine.normalizeSlots) StrategyEngine.normalizeSlots(scenarios[2].settings);
  } catch (err) {
    errors.push(`normalizeSlots threw: ${err.message}`);
  }

  return errors;
}

// ---- Sync -------------------------------------------------------------------
function main() {
  log(`source:   ${SOURCE_DIR}`);
  log(`snapshot: ${SNAPSHOT_DIR}`);

  for (const file of LOAD_ORDER) {
    if (!fs.existsSync(path.join(SOURCE_DIR, file))) {
      log(`FAIL — source file missing: ${file}`);
      process.exit(1);
    }
  }

  log('validating candidate strategy code...');
  const errors = validate(SOURCE_DIR);
  if (errors.length) {
    log('FAIL — candidate code did NOT pass validation. Snapshot NOT updated; bot keeps the previous known-good strategy.');
    errors.forEach((e) => log(`  - ${e}`));
    process.exit(1);
  }
  log('validation passed');

  // Stage into a temp dir first so a crash mid-copy can't leave a torn snapshot.
  const staging = `${SNAPSHOT_DIR}.staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const file of LOAD_ORDER) {
    fs.copyFileSync(path.join(SOURCE_DIR, file), path.join(staging, file));
  }
  fs.writeFileSync(path.join(staging, 'SNAPSHOT.json'), JSON.stringify({
    syncedAt: new Date().toISOString(),
    files: LOAD_ORDER,
  }, null, 2));

  fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  fs.renameSync(staging, SNAPSHOT_DIR);
  log(`snapshot updated (${LOAD_ORDER.length} files)`);
}

main();
