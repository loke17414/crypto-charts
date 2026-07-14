/* Paper USDT-M futures wallet with leverage */
const FuturesPaper = (() => {
  const STORAGE_KEY = 'crypto-charts-futures-paper';
  const DEFAULT_BALANCE = 10000;

  let wallet = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      wallet = raw ? JSON.parse(raw) : null;
    } catch {
      wallet = null;
    }
    if (!wallet) reset(false);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
    } catch { /* ignore */ }
  }

  function reset(persist = true) {
    wallet = {
      margin: DEFAULT_BALANCE,
      position: null,
      history: [],
      totalPnl: 0,
    };
    if (persist) save();
  }

  function getPosition() {
    return wallet.position;
  }

  function unrealizedPnl(price) {
    const pos = wallet.position;
    if (!pos) return 0;
    if (pos.side === 'LONG') return (price - pos.entryPrice) * pos.quantity;
    return (pos.entryPrice - price) * pos.quantity;
  }

  function roe(price, leverage) {
    const pos = wallet.position;
    if (!pos) return 0;
    return (unrealizedPnl(price) / pos.margin) * 100;
  }

  function openPosition(side, price, marginUsdt, leverage, stopPrice = null, takeProfitPrice = null) {
    if (wallet.position) {
      return { ok: false, message: '이미 포지션이 있습니다. 먼저 청산하세요.' };
    }
    if (marginUsdt > wallet.margin + 1e-8) {
      return { ok: false, message: `증거금 부족 (보유 $${wallet.margin.toFixed(2)})` };
    }

    const notional = marginUsdt * leverage;
    const qty = notional / price;

    wallet.margin -= marginUsdt;
    wallet.position = {
      side,
      quantity: qty,
      entryPrice: price,
      margin: marginUsdt,
      leverage,
      stopPrice,
      takeProfitPrice,
      openTime: Date.now(),
    };
    wallet.history.unshift({
      type: 'OPEN',
      side,
      qty,
      price,
      margin: marginUsdt,
      leverage,
      time: Date.now(),
    });
    if (wallet.history.length > 100) wallet.history.length = 100;
    save();

    return {
      ok: true,
      message: `${side} 진입: ${qty.toFixed(6)} BTC @ $${price.toFixed(2)} (${leverage}x, 증거금 $${marginUsdt.toFixed(2)})`,
    };
  }

  function closePosition(price, reason = '') {
    const pos = wallet.position;
    if (!pos) return { ok: false, message: '포지션이 없습니다.' };

    const pnl = pos.side === 'LONG'
      ? (price - pos.entryPrice) * pos.quantity
      : (pos.entryPrice - price) * pos.quantity;
    const roePct = (pnl / pos.margin) * 100;

    wallet.margin += pos.margin + pnl;
    wallet.totalPnl += pnl;
    wallet.position = null;

    wallet.history.unshift({
      type: 'CLOSE',
      side: pos.side,
      qty: pos.quantity,
      price,
      pnl,
      roe: roePct,
      reason,
      time: Date.now(),
    });
    if (wallet.history.length > 100) wallet.history.length = 100;
    save();

    return {
      ok: true,
      message: `${pos.side} 청산 @ $${price.toFixed(2)} | 손익 $${pnl.toFixed(2)} (ROE ${roePct >= 0 ? '+' : ''}${roePct.toFixed(2)}%)`,
      pnl,
      roe: roePct,
    };
  }

  function getStatus(price, leverage) {
    const lines = [`💰 사용 가능 증거금: $${wallet.margin.toFixed(2)}`];
    lines.push(`📈 누적 실현손익: $${wallet.totalPnl.toFixed(2)}`);

    const pos = wallet.position;
    if (!pos) {
      lines.push('📭 포지션 없음');
    } else {
      const pnl = unrealizedPnl(price);
      const roePct = roe(price, leverage);
      lines.push(
        `📊 ${pos.side} ${pos.quantity.toFixed(6)} BTC`,
        `   진입 $${pos.entryPrice.toFixed(2)} | ${pos.leverage}x | 증거금 $${pos.margin.toFixed(2)}`,
        `   미실현 $${pnl.toFixed(2)} (ROE ${roePct >= 0 ? '+' : ''}${roePct.toFixed(2)}%)`,
      );
    }
    return lines.join('\n');
  }

  function getWallet() {
    return { ...wallet, position: wallet.position ? { ...wallet.position } : null };
  }

  function getEquity(price = 0) {
    let equity = wallet.margin;
    const pos = wallet.position;
    if (pos && price) {
      equity += pos.margin + unrealizedPnl(price);
    } else if (pos) {
      equity += pos.margin;
    }
    return equity;
  }

  load();

  return {
    openPosition,
    closePosition,
    getPosition,
    unrealizedPnl,
    roe,
    getStatus,
    reset,
    getWallet,
    getEquity,
  };
})();

window.FuturesPaper = FuturesPaper;
