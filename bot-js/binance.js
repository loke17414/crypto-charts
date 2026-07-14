'use strict';

/*
 * Binance USDT-M Futures REST client for Node — a faithful port of
 * bot/exchange.py so server orders match the tested Python path exactly
 * (same endpoints, HMAC-SHA256 signing, LOT_SIZE rounding, market orders).
 */

const crypto = require('crypto');

const MAINNET = 'https://fapi.binance.com';
const TESTNET = 'https://testnet.binancefuture.com';

class BinanceFuturesClient {
  constructor({ apiKey, apiSecret, symbol, interval, leverage, marginType, useTestnet }) {
    this.apiKey = apiKey || '';
    this.apiSecret = apiSecret || '';
    this.symbol = symbol;
    this.interval = interval;
    this.leverage = leverage;
    this.marginType = marginType || 'ISOLATED';
    this.baseUrl = useTestnet ? TESTNET : MAINNET;
    this._filters = null;
  }

  _sign(params) {
    const withTs = { ...params, timestamp: Date.now() };
    const query = new URLSearchParams(
      Object.entries(withTs).map(([k, v]) => [k, String(v)]),
    ).toString();
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(query)
      .digest('hex');
    return `${query}&signature=${signature}`;
  }

  async _request(method, path, params = {}, signed = false) {
    let url = `${this.baseUrl}${path}`;
    const headers = {};
    if (this.apiKey) headers['X-MBX-APIKEY'] = this.apiKey;

    let body;
    if (signed) {
      const qs = this._sign(params);
      if (method === 'GET' || method === 'DELETE') {
        url += `?${qs}`;
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = qs;
      }
    } else {
      const entries = Object.entries(params);
      if (entries.length) {
        const qs = new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
        url += `?${qs}`;
      }
    }

    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = (data && (data.msg || data.raw)) || text || res.statusText;
      throw new Error(`${res.status} ${msg}`);
    }
    return data;
  }

  async ping() {
    try {
      await this._request('GET', '/fapi/v1/ping');
      return true;
    } catch {
      return false;
    }
  }

  async getKlines(limit = 200) {
    return this._request('GET', '/fapi/v1/klines', {
      symbol: this.symbol,
      interval: this.interval,
      limit,
    });
  }

  async getTotalEquity() {
    const balances = await this._request('GET', '/fapi/v2/balance', {}, true);
    const usdt = balances.find((b) => b.asset === 'USDT');
    return usdt ? parseFloat(usdt.balance) : 0;
  }

  async getUsdtBalance() {
    const balances = await this._request('GET', '/fapi/v2/balance', {}, true);
    const usdt = balances.find((b) => b.asset === 'USDT');
    return usdt ? parseFloat(usdt.availableBalance) : 0;
  }

  async getPosition() {
    const positions = await this._request('GET', '/fapi/v2/positionRisk', {}, true);
    for (const p of positions) {
      if (p.symbol !== this.symbol) continue;
      const amt = parseFloat(p.positionAmt);
      if (Math.abs(amt) < 1e-8) return null;
      return {
        side: amt > 0 ? 'LONG' : 'SHORT',
        quantity: Math.abs(amt),
        entryPrice: parseFloat(p.entryPrice),
        unrealizedPnl: parseFloat(p.unRealizedProfit),
        leverage: parseInt(p.leverage, 10),
      };
    }
    return null;
  }

  async setupLeverageAndMargin() {
    try {
      await this._request('POST', '/fapi/v1/marginType', {
        symbol: this.symbol,
        marginType: this.marginType,
      }, true);
    } catch (err) {
      if (!String(err.message).includes('No need to change margin type')) throw err;
    }
    await this._request('POST', '/fapi/v1/leverage', {
      symbol: this.symbol,
      leverage: this.leverage,
    }, true);
  }

  async getSymbolFilters() {
    if (this._filters) return this._filters;
    const info = await this._request('GET', '/fapi/v1/exchangeInfo');
    const sym = info.symbols.find((s) => s.symbol === this.symbol);
    if (!sym) throw new Error(`Symbol ${this.symbol} not found`);
    const filters = {};
    sym.filters.forEach((f) => { filters[f.filterType] = f; });
    this._filters = {
      stepSize: parseFloat(filters.LOT_SIZE.stepSize),
      minQty: parseFloat(filters.LOT_SIZE.minQty),
      minNotional: parseFloat((filters.MIN_NOTIONAL || { notional: '5' }).notional),
    };
    return this._filters;
  }

  static _roundStep(value, step) {
    if (step <= 0) return value;
    const stepStr = String(step);
    const precision = stepStr.includes('.')
      ? stepStr.replace(/0+$/, '').split('.')[1].length
      : 0;
    const rounded = Math.floor(value / step) * step;
    return Number(rounded.toFixed(precision));
  }

  async calcQuantity(notionalUsdt, price) {
    const f = await this.getSymbolFilters();
    const qty = BinanceFuturesClient._roundStep(notionalUsdt / price, f.stepSize);
    if (qty < f.minQty) throw new Error(`Quantity ${qty} below minimum ${f.minQty}`);
    if (qty * price < f.minNotional) {
      throw new Error(`Notional $${(qty * price).toFixed(2)} below minimum $${f.minNotional}`);
    }
    return qty;
  }

  async marketOrder(side, quantity, reduceOnly = false) {
    const f = await this.getSymbolFilters();
    const qty = BinanceFuturesClient._roundStep(quantity, f.stepSize);
    const params = {
      symbol: this.symbol,
      side,
      type: 'MARKET',
      quantity: qty.toFixed(8).replace(/0+$/, '').replace(/\.$/, ''),
    };
    if (reduceOnly) params.reduceOnly = 'true';
    return this._request('POST', '/fapi/v1/order', params, true);
  }

  openLong(qty) { return this.marketOrder('BUY', qty); }
  openShort(qty) { return this.marketOrder('SELL', qty); }
  closeLong(qty) { return this.marketOrder('SELL', qty, true); }
  closeShort(qty) { return this.marketOrder('BUY', qty, true); }
}

module.exports = { BinanceFuturesClient };
