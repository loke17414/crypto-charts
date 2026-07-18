'use strict';

/*
 * Config loader for the Node 24/7 bot. Reads the same .env variables the
 * Python bot uses (BINANCE_API_KEY, SYMBOL, LEVERAGE, ...) plus a strategy JSON
 * file that carries the exact entryRules/exitRules built in the trading UI
 * (export it from the UI with the "전략 내보내기 (서버용)" button).
 */

const fs = require('fs');
const path = require('path');

function loadDotEnv(rootDir) {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  });
}

const bool = (v, def) => {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes'].includes(String(v).toLowerCase());
};
const num = (v, def) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
};
const int = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

function normalizeSlotsFromFile(slots) {
  if (!Array.isArray(slots) || !slots.length) return undefined;
  return slots.map((s) => {
    if (!s || typeof s !== 'object') return s;
    const entryRules = s.entryRules ?? s.rules;
    if (entryRules && !s.entryRules) return { ...s, entryRules };
    return s;
  });
}

function loadStrategy(rootDir) {
  const explicit = process.env.STRATEGY_FILE;
  const candidates = [
    explicit,
    path.join(rootDir, 'strategy.json'),
    path.join(__dirname, 'strategy.json'),
  ].filter(Boolean);

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        return { path: file, settings: JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch (err) {
        throw new Error(`Failed to parse strategy file ${file}: ${err.message}`);
      }
    }
  }
  return { path: null, settings: null };
}

function loadConfig() {
  const rootDir = path.join(__dirname, '..');
  loadDotEnv(rootDir);

  const dryRun = bool(process.env.DRY_RUN, false);
  const useTestnet = bool(process.env.BINANCE_TESTNET, true);
  const apiKey = (process.env.BINANCE_API_KEY || '').trim();
  const apiSecret = (process.env.BINANCE_API_SECRET || '').trim();

  if (!dryRun && (!apiKey || !apiSecret)) {
    throw new Error(
      'BINANCE_API_KEY and BINANCE_API_SECRET are required (or set DRY_RUN=true). '
      + 'Copy .env.example to .env and fill in your testnet keys.',
    );
  }

  const { path: strategyPath, settings: strategyFile } = loadStrategy(rootDir);

  // Risk / execution params: strategy file wins, then .env, then defaults.
  const s = strategyFile || {};
  const leverage = int(s.leverage ?? process.env.LEVERAGE, 5);
  const stopLossPct = num(s.stopLossPct ?? process.env.STOP_LOSS_PCT, 1.5);
  const takeProfitPct = num(s.takeProfitPct ?? process.env.TAKE_PROFIT_PCT, 3.0);
  const allowShort = s.allowShort !== undefined
    ? Boolean(s.allowShort)
    : bool(process.env.ALLOW_SHORT, true);
  // SL is always enabled — useStopLoss toggle removed from UI.
  const useStopLoss = true;

  // The settings object handed to FuturesStrategy — identical shape to the
  // browser's getSettings() output.
  const settings = {
    leverage,
    stopLossPct,
    takeProfitPct,
    allowShort,
    useStopLoss,
    rsiPeriod: int(s.rsiPeriod ?? process.env.RSI_PERIOD, 14),
    rsiOversold: num(s.rsiOversold ?? process.env.RSI_OVERSOLD, 25),
    rsiOverbought: num(s.rsiOverbought ?? process.env.RSI_OVERBOUGHT, 70),
    entryRules: s.entryRules ?? null,
    exitRules: s.exitRules ?? null,
    strategySlots: normalizeSlotsFromFile(s.strategySlots),
  };

  return {
    rootDir,
    dryRun,
    useTestnet,
    apiKey,
    apiSecret,
    symbol: (s.symbol || process.env.SYMBOL || 'BTCUSDT').toUpperCase(),
    interval: s.interval || process.env.INTERVAL || '1h',
    marginType: (process.env.MARGIN_TYPE || 'ISOLATED').toUpperCase(),
    leverage,
    riskPerTradePct: num(s.riskPerTradePct ?? process.env.RISK_PER_TRADE_PCT, 1.0),
    maxAccountLossPct: num(s.maxAccountLossPct ?? process.env.MAX_ACCOUNT_LOSS_PCT, 5.0),
    pollSeconds: int(s.pollSeconds ?? process.env.POLL_SECONDS, 60),
    signalCheckSeconds: int(s.signalCheckSeconds ?? process.env.SIGNAL_CHECK_SECONDS, 3),
    entryCooldownSeconds: int(s.entryCooldownSeconds ?? process.env.ENTRY_COOLDOWN_SECONDS, 60),
    dryCash: num(process.env.DRY_CASH, 10000),
    strategyPath,
    hasStrategyFile: Boolean(strategyFile),
    settings,
  };
}

module.exports = { loadConfig, normalizeSlotsFromFile };
