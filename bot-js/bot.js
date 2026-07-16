'use strict';

/*
 * Headless 24/7 auto-trading bot. Runs the SAME strategy engine as the trading
 * UI, but loaded from the bot's OWN validated snapshot (bot-js/strategy/, see
 * sync-strategy.js) so website code changes can never crash the running bot.
 * Entry rules still come from strategy.json exported from the UI. Replicates
 * the UI bot loop (futures-bot-app.js botTick + evaluateLiveExit):
 *   - poll every pollSeconds
 *   - on an open position: intrabar wick exit (checkExitBar on the forming
 *     candle high/low) so fast SL/TP touches between polls are not missed,
 *     matching the backtest's intrabar exit semantics
 *   - otherwise: FuturesStrategy.analyze() and open a risk-sized position on a
 *     LONG/SHORT signal
 * Position state is persisted so a restart (crash / server reboot) resumes.
 */

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./config');
const { buildRuntime } = require('./strategy-runtime');
const { BinanceFuturesClient } = require('./binance');

const cfg = loadConfig();
const brain = buildRuntime();
const { FuturesStrategy, StrategyEngine, RiskSizing } = brain;

const STATE_FILE = path.join(cfg.rootDir, 'bot-js-state.json');
const LOG_DIR = path.join(cfg.rootDir, 'logs');

function log(msg, level = 'INFO') {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `bot-js-${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, line + '\n');
  } catch { /* logging must never crash the loop */ }
}

// ---- Runtime state -------------------------------------------------------
let running = true;
let position = null; // { side, entryPrice, quantity, stopPrice, takeProfitPrice, stopLossPct, takeProfitPct, entryTime }
let sessionStartEquity = 0;
let dryCash = cfg.dryCash;

const mode = cfg.dryRun ? 'DRY RUN' : (cfg.useTestnet ? 'TESTNET' : 'LIVE');

const client = new BinanceFuturesClient({
  apiKey: cfg.apiKey,
  apiSecret: cfg.apiSecret,
  symbol: cfg.symbol,
  interval: cfg.interval,
  leverage: cfg.leverage,
  marginType: cfg.marginType,
  useTestnet: cfg.useTestnet,
});

function saveState() {
  const payload = {
    symbol: cfg.symbol,
    interval: cfg.interval,
    leverage: cfg.leverage,
    position,
    dryCash: cfg.dryRun ? dryCash : undefined,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    log(`Could not save state: ${err.message}`, 'WARN');
  }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (data.symbol === cfg.symbol && data.position) {
      position = data.position;
      log(`Restored saved position: ${position.side} ${position.quantity} @ $${position.entryPrice}`);
    }
    if (cfg.dryRun && Number.isFinite(data.dryCash)) dryCash = data.dryCash;
  } catch (err) {
    log(`Could not load state: ${err.message}`, 'WARN');
  }
}

// ---- Data ---------------------------------------------------------------
// Map Binance klines to the candle shape the strategy engine expects (time in
// seconds, numeric OHLCV) — identical to the browser's kline loader.
function toCandles(raw) {
  return raw.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function getEquity(price) {
  if (cfg.dryRun) {
    let equity = dryCash;
    if (position && price) {
      const upnl = position.side === 'LONG'
        ? (price - position.entryPrice) * position.quantity
        : (position.entryPrice - price) * position.quantity;
      equity += position.marginUsdt + upnl;
    }
    return equity;
  }
  return client.getTotalEquity();
}

async function getAvailableMargin() {
  if (cfg.dryRun) return dryCash;
  return client.getUsdtBalance();
}

// ---- Exchange sync ------------------------------------------------------
async function syncPositionFromExchange() {
  if (cfg.dryRun) return;
  const live = await client.getPosition();
  if (live && !position) {
    let sltp = { stop_price: null, take_profit_price: null };
    try {
      sltp = await client.getSlTpOrders();
    } catch { /* ignore */ }
    position = {
      side: live.side,
      entryPrice: live.entryPrice,
      quantity: live.quantity,
      marginUsdt: (live.quantity * live.entryPrice) / (live.leverage || cfg.leverage),
      stopPrice: sltp.stop_price,
      takeProfitPrice: sltp.take_profit_price,
      stopLossPct: cfg.settings.stopLossPct,
      takeProfitPct: cfg.settings.takeProfitPct,
      entryTime: new Date().toISOString(),
      exchangeSlTp: Boolean(sltp.stop_price || sltp.take_profit_price),
    };
    log(`Synced position from exchange: ${position.side} ${position.quantity} @ $${position.entryPrice}`);
  } else if (!live && position) {
    log('Exchange position closed (SL/TP 체결 또는 수동 청산) — 로컬 상태 초기화');
    position = null;
    entryPausedUntil = Date.now() + Math.min(intervalSeconds(cfg.interval) * 1000, 15 * 60_000);
    blockEntryUntilSignalClears = true;
    saveState();
  }
}

let entryPausedUntil = 0;
let blockEntryUntilSignalClears = false;

// ---- Strategy hot reload --------------------------------------------------
// The UI rewrites strategy.json when GPT or the user changes SL/TP or entry
// rules while the bot is running. Reload it on mtime change so those edits
// apply without a bot restart. Symbol/interval/leverage need a client re-init
// and are intentionally NOT hot-swapped.
let strategyMtimeMs = (() => {
  try {
    return cfg.strategyPath ? fs.statSync(cfg.strategyPath).mtimeMs : 0;
  } catch { return 0; }
})();

function maybeReloadStrategy() {
  if (!cfg.strategyPath) return;
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(cfg.strategyPath).mtimeMs;
  } catch { return; }
  if (mtimeMs === strategyMtimeMs) return;
  strategyMtimeMs = mtimeMs;

  let s;
  try {
    s = JSON.parse(fs.readFileSync(cfg.strategyPath, 'utf8'));
  } catch (err) {
    log(`strategy.json reload failed (${err.message}) — keeping current settings`, 'WARN');
    return;
  }

  const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
  const st = cfg.settings;
  st.stopLossPct = num(s.stopLossPct, st.stopLossPct);
  st.takeProfitPct = num(s.takeProfitPct, st.takeProfitPct);
  st.useStopLoss = s.useStopLoss !== false;
  if (s.allowShort !== undefined) st.allowShort = Boolean(s.allowShort);
  st.rsiPeriod = num(s.rsiPeriod, st.rsiPeriod);
  st.rsiOversold = num(s.rsiOversold, st.rsiOversold);
  st.rsiOverbought = num(s.rsiOverbought, st.rsiOverbought);
  if ('entryRules' in s) st.entryRules = s.entryRules ?? null;
  if ('exitRules' in s) st.exitRules = s.exitRules ?? null;
  st.strategySlots = Array.isArray(s.strategySlots) && s.strategySlots.length
    ? s.strategySlots
    : undefined;
  cfg.riskPerTradePct = num(s.riskPerTradePct, cfg.riskPerTradePct);
  cfg.maxAccountLossPct = num(s.maxAccountLossPct, cfg.maxAccountLossPct);

  const slLabel = st.useStopLoss === false ? '없음' : `-${st.stopLossPct}%`;
  log(`strategy.json reloaded — SL ${slLabel} · TP +${st.takeProfitPct}% · allowShort ${st.allowShort}`);
  if ((s.symbol && s.symbol.toUpperCase() !== cfg.symbol) || (s.interval && s.interval !== cfg.interval)) {
    log(`symbol/interval change (${s.symbol}/${s.interval}) requires a bot restart — still trading ${cfg.symbol}/${cfg.interval}`, 'WARN');
  }
}

function intervalSeconds(iv) {
  const m = /^(\d+)([mhdw])$/.exec(String(iv || ''));
  if (!m) return 60;
  const n = parseInt(m[1], 10);
  return { m: 60, h: 3600, d: 86400, w: 604800 }[m[2]] * n;
}

// ---- Orders -------------------------------------------------------------
async function openPosition(side, price, levels, candles, index) {
  if (position) return;

  const equity = await getEquity(price);
  const margin = RiskSizing.calcTradeMargin(equity, {
    riskPerTradePct: cfg.riskPerTradePct,
    leverage: cfg.leverage,
    stopLossPct: cfg.settings.stopLossPct,
  });

  const available = await getAvailableMargin();
  let notional = margin * cfg.leverage;
  notional = Math.min(notional, available * cfg.leverage);
  if (notional < 5) {
    log(`진입 생략 — 주문 금액이 너무 작음 ($${notional.toFixed(2)}, 최소 약 $5). 잔고·리스크 설정을 확인하세요.`, 'WARN');
    return;
  }

  if (cfg.dryRun) {
    const qty = Number((notional / price).toFixed(3));
    const usedMargin = (qty * price) / cfg.leverage;
    dryCash -= usedMargin;
    position = {
      side,
      entryPrice: price,
      quantity: qty,
      marginUsdt: usedMargin,
      stopPrice: levels.stopPrice,
      takeProfitPrice: levels.takeProfitPrice,
      stopLossPct: levels.stopLossPct,
      takeProfitPct: levels.takeProfitPct,
      entryTime: new Date().toISOString(),
      entryBarTime: candles?.[index]?.time ?? null,
    };
    log(`[DRY] OPEN ${side} ${qty} @ $${price.toFixed(2)} | SL ${levels.stopPrice != null ? `$${levels.stopPrice.toFixed(2)}` : '없음'} TP $${levels.takeProfitPrice.toFixed(2)} (실제 주문 없음)`, 'WARN');
    saveState();
    return;
  }

  const qty = await client.calcQuantity(notional, price);
  await client.setupLeverageAndMargin();
  if (side === 'LONG') await client.openLong(qty);
  else await client.openShort(qty);

  const live = await client.getPosition();
  const entryPrice = live ? live.entryPrice : price;
  const filledQty = live ? live.quantity : qty;
  position = {
    side,
    entryPrice,
    quantity: filledQty,
    marginUsdt: (filledQty * entryPrice) / cfg.leverage,
    stopPrice: levels.stopPrice,
    takeProfitPrice: levels.takeProfitPrice,
    stopLossPct: levels.stopLossPct,
    takeProfitPct: levels.takeProfitPct,
    entryTime: new Date().toISOString(),
    entryBarTime: candles?.[index]?.time ?? null,
    exchangeSlTp: false,
  };
  log(`OPEN ${side} ${filledQty} @ $${entryPrice.toFixed(2)} | SL ${levels.stopPrice != null ? `$${levels.stopPrice.toFixed(2)}` : '없음'} TP $${levels.takeProfitPrice.toFixed(2)}`);

  if (levels.stopPrice || levels.takeProfitPrice) {
    try {
      const sltp = await client.setSlTp(side, levels.stopPrice, levels.takeProfitPrice);
      position.exchangeSlTp = true;
      if (sltp.stop_price != null) position.stopPrice = sltp.stop_price;
      if (sltp.take_profit_price != null) position.takeProfitPrice = sltp.take_profit_price;
      log(`바이낸스 SL/TP 등록 — SL ${sltp.stop_price != null ? `$${sltp.stop_price}` : '없음'} · TP ${sltp.take_profit_price != null ? `$${sltp.take_profit_price}` : '없음'}`);
    } catch (err) {
      log(`바이낸스 SL/TP 등록 실패: ${err.message} — 봇이 종가 기준으로 청산합니다`, 'WARN');
    }
  }
  saveState();
}

async function closePosition(price, reason) {
  if (!position) return;
  const { side, entryPrice, quantity } = position;
  const pnlPct = FuturesStrategy.calcPnlPct(side, entryPrice, price) * cfg.leverage;

  if (cfg.dryRun) {
    const pnl = side === 'LONG'
      ? (price - entryPrice) * quantity
      : (entryPrice - price) * quantity;
    dryCash += position.marginUsdt + pnl;
    log(`[DRY] CLOSE ${side} ${quantity} @ $${price.toFixed(2)} | ROE ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% — ${reason}`);
    position = null;
    saveState();
    return;
  }

  if (side === 'LONG') await client.closeLong(quantity);
  else await client.closeShort(quantity);
  try {
    await client.cancelAllOrders();
  } catch { /* ignore */ }
  log(`CLOSE ${side} ${quantity} @ $${price.toFixed(2)} | ROE ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% — ${reason}`);
  position = null;
  saveState();
}

// ---- Main tick ----------------------------------------------------------
async function tick() {
  maybeReloadStrategy();
  const raw = await client.getKlines(200);
  const candles = toCandles(raw);
  if (candles.length < 2) return;

  const forming = candles[candles.length - 1];
  const price = forming.close;

  // Account loss limit — stop trading (do not auto-close) like the UI.
  if (sessionStartEquity > 0) {
    const equity = await getEquity(price);
    if (RiskSizing.isAccountLossLimitHit(equity, sessionStartEquity, cfg.maxAccountLossPct)) {
      log(`Account loss limit hit (-${cfg.maxAccountLossPct}% from session start) — stopping bot`, 'WARN');
      running = false;
      return;
    }
  }

  if (!cfg.dryRun) await syncPositionFromExchange();

  // Exit check first (intrabar wick on the forming candle). On the bar the
  // position was ENTERED, the bar's wick predates the entry — using it would
  // trigger phantom exits from price action that happened before we were in
  // the trade, so that bar is checked against the live price only.
  if (position) {
    // Exchange SL/TP orders handle exit — only sync position state here.
    if (!cfg.dryRun && position.exchangeSlTp) {
      return;
    }

    const extras = {
      stopPrice: position.stopPrice ?? undefined,
      takeProfitPrice: position.takeProfitPrice ?? undefined,
      stopLossPct: position.stopLossPct ?? cfg.settings.stopLossPct,
      takeProfitPct: position.takeProfitPct ?? cfg.settings.takeProfitPct,
      useStopLoss: cfg.settings.useStopLoss !== false,
    };
    const sameBarAsEntry = position.entryBarTime != null && forming.time === position.entryBarTime;
    // Live bot: use close price only (not wick) to avoid false exits on forming candles.
    // Backtest uses checkExitBar; dry-run simulation keeps wick semantics.
    const exit = (cfg.dryRun && !sameBarAsEntry)
      ? FuturesStrategy.checkExitBar(position.side, position.entryPrice, forming, cfg.settings, extras)
      : FuturesStrategy.checkExit(position.side, position.entryPrice, price, cfg.settings, extras);
    if (exit) {
      await closePosition(exit.exitPrice ?? price, exit.reason);
      return;
    }
  }

  // Entry — evaluate the SAME analyze() the UI uses, on the same candle set.
  const posSide = position ? position.side : null;
  const result = FuturesStrategy.analyze(candles, cfg.settings, posSide);

  // A manual close blocks re-entry until the entry signal goes away at least
  // once; the flag clears on any non-entry tick so the next fresh signal works.
  if (blockEntryUntilSignalClears && result.signal !== 'LONG' && result.signal !== 'SHORT') {
    blockEntryUntilSignalClears = false;
    log('Entry signal cleared — new signals can enter again');
  }

  if (!position && (result.signal === 'LONG' || result.signal === 'SHORT')) {
    if (blockEntryUntilSignalClears) {
      logHoldReason(`Signal ${result.signal} skipped — waiting for signal to clear after manual close`);
      return;
    }
    if (Date.now() < entryPausedUntil) {
      logHoldReason(`Signal ${result.signal} skipped — cooldown after external close`);
      return;
    }
    if (result.signal === 'SHORT' && !cfg.settings.allowShort) {
      log(`Signal SHORT ignored (allowShort=false) — ${result.reason}`);
      return;
    }
    const levels = result.entryLevels;
    if (!levels) {
      log(`Entry skipped — no SL/TP levels — ${result.reason}`, 'WARN');
      return;
    }
    log(`SIGNAL ${result.signal} @ $${price.toFixed(2)} — ${result.reason}`);
    await openPosition(result.signal, price, levels, candles, candles.length - 1);
  } else {
    logHoldReason(result.reason);
  }
}

// The fast tick cadence (see start()) would spam identical HOLD lines, so only
// log the reason when it changes or once per pollSeconds.
let lastHoldReason = null;
let lastHoldLogAt = 0;
function logHoldReason(reason) {
  const now = Date.now();
  if (reason === lastHoldReason && now - lastHoldLogAt < cfg.pollSeconds * 1000) return;
  lastHoldReason = reason;
  lastHoldLogAt = now;
  log(`${reason}`, 'DEBUG');
}

// ---- Runner -------------------------------------------------------------
async function start() {
  log(`Starting Futures bot [${mode}] ${cfg.symbol} ${cfg.interval} | ${cfg.leverage}x ${cfg.marginType} | risk ${cfg.riskPerTradePct}%/trade | poll ${cfg.pollSeconds}s`);
  if (cfg.dryRun) {
    log('DRY_RUN=true — 시뮬레이션만 합니다. UI에서 봇 시작 시 live_trading으로 실제 테스트넷 주문 가능', 'WARN');
  }

  if (!cfg.hasStrategyFile) {
    log('No strategy.json found — falling back to the RSI oversold/overbought preset. Export your UI strategy for full parity.', 'WARN');
  } else if (StrategyEngine.normalizeSlots) {
    const slots = StrategyEngine.normalizeSlots(cfg.settings);
    log(`Strategy: ${StrategyEngine.slotsSummary ? StrategyEngine.slotsSummary(slots) : slots.length + ' slot(s)'}`);
    slots.forEach((slot) => {
      if (StrategyEngine.validateEntryRules) {
        StrategyEngine.validateEntryRules(slot.rules).warnings.forEach((w) => {
          log(`Strategy warning${slot.name ? ` [${slot.name}]` : ''}: ${w}`, 'WARN');
        });
      }
    });
  } else {
    const rules = StrategyEngine.normalizeRules(cfg.settings);
    log(`Strategy: ${StrategyEngine.rulesSummary(rules)}`);
    if (StrategyEngine.validateEntryRules) {
      StrategyEngine.validateEntryRules(rules).warnings.forEach((w) => log(`Strategy warning: ${w}`, 'WARN'));
    }
  }

  if (!cfg.dryRun) {
    if (!(await client.ping())) {
      log('Cannot connect to Binance Futures API', 'ERROR');
      process.exit(1);
    }
    await client.setupLeverageAndMargin();
  }

  loadState();
  if (!cfg.dryRun) {
    await syncPositionFromExchange();
    if (position) {
      try {
        const sltp = await client.getSlTpOrders();
        position.exchangeSlTp = Boolean(sltp.stop_price || sltp.take_profit_price);
        if (sltp.stop_price != null) position.stopPrice = sltp.stop_price;
        if (sltp.take_profit_price != null) position.takeProfitPrice = sltp.take_profit_price;
      } catch { /* ignore */ }
    }
  }

  sessionStartEquity = await getEquity(0);
  const balance = await getAvailableMargin();
  log(`Equity $${sessionStartEquity.toFixed(2)} | Available $${balance.toFixed(2)} | Position: ${position ? `${position.side} ${position.quantity} @ $${position.entryPrice}` : 'none'}`);

  // Fast tick so edge-triggered entry signals (fresh crossovers that appear
  // and disappear within one poll window) are caught, and wick SL/TP exits
  // react quickly. Klines fetch is cheap (weight 2), so 10s is safe.
  const tickSeconds = Math.min(cfg.pollSeconds, 10);
  log(`Signal check every ${tickSeconds}s (pollSeconds=${cfg.pollSeconds})`);
  while (running) {
    try {
      await tick();
    } catch (err) {
      log(`Error during tick: ${err.message}`, 'ERROR');
    }
    await new Promise((r) => setTimeout(r, tickSeconds * 1000));
  }
  log('Bot stopped.');
}

function shutdown() {
  log('Shutting down...');
  running = false;
  saveState();
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  log(`Fatal: ${err.stack || err.message}`, 'ERROR');
  process.exit(1);
});
