/* Paper trading simulator — no real orders */
const PaperTrading = (() => {
  const STORAGE_KEY = 'crypto-charts-paper-trading';
  const DEFAULT_BALANCE = 10000;

  let wallet = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      wallet = raw ? JSON.parse(raw) : null;
    } catch {
      wallet = null;
    }
    if (!wallet) {
      wallet = {
        usdt: DEFAULT_BALANCE,
        positions: {},
        history: [],
      };
      save();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
    } catch { /* ignore */ }
  }

  function reset() {
    wallet = { usdt: DEFAULT_BALANCE, positions: {}, history: [] };
    save();
  }

  function getPosition(symbol) {
    return wallet.positions[symbol] || { qty: 0, avgPrice: 0 };
  }

  function buy(symbol, qty, price, coinName) {
    const cost = qty * price;
    if (cost > wallet.usdt + 1e-8) {
      return { ok: false, message: `USDT 잔고 부족 (보유: ${wallet.usdt.toFixed(2)} USDT, 필요: ${cost.toFixed(2)} USDT)` };
    }
    const pos = getPosition(symbol);
    const newQty = pos.qty + qty;
    const newAvg = newQty > 0 ? (pos.qty * pos.avgPrice + cost) / newQty : 0;

    wallet.usdt -= cost;
    wallet.positions[symbol] = { qty: newQty, avgPrice: newAvg, coinName: coinName || symbol };
    wallet.history.unshift({
      type: 'BUY',
      symbol,
      coinName: coinName || symbol,
      qty,
      price,
      total: cost,
      time: Date.now(),
    });
    if (wallet.history.length > 100) wallet.history.length = 100;
    save();
    return {
      ok: true,
      message: `모의 매수 체결: ${coinName || symbol} ${qty.toFixed(6)} @ $${price.toFixed(2)} (합계 $${cost.toFixed(2)})`,
    };
  }

  function sell(symbol, qty, price, coinName) {
    const pos = getPosition(symbol);
    if (qty > pos.qty + 1e-8) {
      return { ok: false, message: `보유 수량 부족 (보유: ${pos.qty.toFixed(6)})` };
    }
    const revenue = qty * price;
    const pnl = (price - pos.avgPrice) * qty;
    const newQty = pos.qty - qty;

    wallet.usdt += revenue;
    if (newQty < 1e-8) delete wallet.positions[symbol];
    else wallet.positions[symbol] = { ...pos, qty: newQty };

    wallet.history.unshift({
      type: 'SELL',
      symbol,
      coinName: coinName || symbol,
      qty,
      price,
      total: revenue,
      pnl,
      time: Date.now(),
    });
    if (wallet.history.length > 100) wallet.history.length = 100;
    save();
    return {
      ok: true,
      message: `모의 매도 체결: ${coinName || symbol} ${qty.toFixed(6)} @ $${price.toFixed(2)} (손익 $${pnl.toFixed(2)})`,
    };
  }

  function sellAll(symbol, price) {
    const pos = getPosition(symbol);
    if (pos.qty < 1e-8) return { ok: false, message: '보유 포지션이 없습니다.' };
    return sell(symbol, pos.qty, price, pos.coinName);
  }

  function getStatus(symbol, currentPrice) {
    const pos = symbol ? getPosition(symbol) : null;
    const lines = [`💰 USDT 잔고: $${wallet.usdt.toFixed(2)}`];

    const entries = Object.entries(wallet.positions);
    if (!entries.length) {
      lines.push('📭 보유 코인 없음');
    } else {
      lines.push('📊 보유 포지션:');
      entries.forEach(([sym, p]) => {
        const val = p.qty * (sym === symbol && currentPrice ? currentPrice : p.avgPrice);
        const pnl = sym === symbol && currentPrice ? (currentPrice - p.avgPrice) * p.qty : 0;
        lines.push(`  · ${p.coinName || sym}: ${p.qty.toFixed(6)} (평단 $${p.avgPrice.toFixed(2)}${pnl ? `, 평가손익 $${pnl.toFixed(2)}` : ''}) ≈ $${val.toFixed(2)}`);
      });
    }

    if (wallet.history.length) {
      const last = wallet.history[0];
      const t = new Date(last.time).toLocaleTimeString('ko-KR');
      lines.push(`🕐 최근 거래: ${last.type} ${last.coinName || last.symbol} @ $${last.price.toFixed(2)} (${t})`);
    }

    return lines.join('\n');
  }

  load();

  return { buy, sell, sellAll, getStatus, reset, getWallet: () => ({ ...wallet }) };
})();

window.PaperTrading = PaperTrading;
