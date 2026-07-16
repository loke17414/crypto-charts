'use strict';

/*
 * Binance USDT-M Futures REST client for Node — a faithful port of
 * bot/exchange.py so server orders match the tested Python path exactly
 * (same endpoints, HMAC-SHA256 signing, LOT_SIZE rounding, market orders).
 */

const crypto = require('crypto');
const { validateSlTp } = require('./sl-tp-utils');

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
    return this.getAvailableBalance();
  }

  /** Free USDT margin for new orders (account-level, most accurate). */
  async getAvailableBalance() {
    try {
      const acct = await this._request('GET', '/fapi/v2/account', {}, true);
      const avail = parseFloat(acct.availableBalance);
      if (Number.isFinite(avail) && avail >= 0) return avail;
    } catch { /* fall back to asset balance */ }
    const balances = await this._request('GET', '/fapi/v2/balance', {}, true);
    const usdt = balances.find((b) => b.asset === 'USDT');
    return usdt ? parseFloat(usdt.availableBalance) : 0;
  }

  async getMarkPrice() {
    const data = await this._request('GET', '/fapi/v1/premiumIndex', { symbol: this.symbol });
    const mark = parseFloat(data.markPrice);
    return Number.isFinite(mark) && mark > 0 ? mark : null;
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
      tickSize: parseFloat((filters.PRICE_FILTER || { tickSize: '0.1' }).tickSize),
      minPrice: parseFloat((filters.PRICE_FILTER || {}).minPrice || 0) || 0,
      maxPrice: parseFloat((filters.PRICE_FILTER || {}).maxPrice || 0) || 0,
    };
    return this._filters;
  }

  static _stepPrecision(step) {
    const stepStr = String(step);
    return stepStr.includes('.')
      ? stepStr.replace(/0+$/, '').split('.')[1].length
      : 0;
  }

  static _roundStep(value, step) {
    if (step <= 0) return value;
    const precision = BinanceFuturesClient._stepPrecision(step);
    const rounded = Math.floor(value / step) * step;
    return Number(rounded.toFixed(precision));
  }

  /** Round trigger prices away from mark so SL/TP are not nudged into instant fill. */
  static _roundTrigger(value, step, mode) {
    if (step <= 0) return value;
    const precision = BinanceFuturesClient._stepPrecision(step);
    const steps = value / step;
    const rounded = (mode === 'up' ? Math.ceil(steps) : Math.floor(steps)) * step;
    return Number(rounded.toFixed(precision));
  }

  /** Smallest notional that satisfies LOT_SIZE minQty and MIN_NOTIONAL at this price. */
  async minViableNotional(price) {
    const f = await this.getSymbolFilters();
    const fromQty = f.minQty * price;
    return Math.max(f.minNotional, fromQty);
  }

  /**
   * Size a market order to fit free margin (initial margin + fee headroom).
   * Returns null when even the exchange minimum cannot be afforded.
   */
  async fitOrderToAvailable(desiredNotional, price, leverage, availableUsdt, { safety = 0.96 } = {}) {
    if (!(price > 0) || !(leverage > 0) || !(availableUsdt > 0)) return null;
    const f = await this.getSymbolFilters();
    const minNotional = Math.max(f.minNotional, f.minQty * price);
    const maxNotional = availableUsdt * leverage * safety;
    if (maxNotional < minNotional) return null;

    let notional = Math.min(Math.max(desiredNotional, 0), maxNotional);
    if (notional < minNotional) notional = minNotional;

    for (let attempt = 0; attempt < 10; attempt++) {
      notional = Math.min(notional, maxNotional);
      if (notional < minNotional) return null;

      let qty = BinanceFuturesClient._roundStep(notional / price, f.stepSize);
      if (qty < f.minQty) {
        qty = f.minQty;
      }
      const actualNotional = qty * price;
      if (actualNotional < f.minNotional) {
        notional = minNotional * 1.02;
        continue;
      }
      const marginReq = actualNotional / leverage;
      if (marginReq <= availableUsdt * safety) {
        return { qty, notional: actualNotional, marginReq };
      }
      notional *= 0.9;
    }
    return null;
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

  _formatPrice(price) {
    const f = this._filters || { tickSize: 0.1 };
    const rounded = BinanceFuturesClient._roundStep(price, f.tickSize);
    return String(rounded).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  async _placeConditional(positionSide, orderType, triggerPrice) {
    const f = await this.getSymbolFilters();
    const isStop = orderType === 'STOP_MARKET';
    const roundMode = positionSide === 'LONG'
      ? (isStop ? 'down' : 'up')
      : (isStop ? 'up' : 'down');
    const rounded = BinanceFuturesClient._roundTrigger(triggerPrice, f.tickSize, roundMode);
    const formatted = String(rounded).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    const num = parseFloat(formatted);
    if (num <= 0 || (f.minPrice && num < f.minPrice)) {
      throw new Error(`${orderType} trigger $${formatted} below min price $${f.minPrice}`);
    }
    if (f.maxPrice && num > f.maxPrice) {
      throw new Error(`${orderType} trigger $${formatted} above max price $${f.maxPrice}`);
    }
    const side = positionSide === 'LONG' ? 'SELL' : 'BUY';
    return this._request('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL',
      symbol: this.symbol,
      side,
      type: orderType,
      triggerPrice: formatted,
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    }, true);
  }

  placeStopMarket(positionSide, stopPrice) {
    return this._placeConditional(positionSide, 'STOP_MARKET', stopPrice);
  }

  placeTakeProfitMarket(positionSide, takeProfitPrice) {
    return this._placeConditional(positionSide, 'TAKE_PROFIT_MARKET', takeProfitPrice);
  }

  async getOpenAlgoOrders() {
    const data = await this._request('GET', '/fapi/v1/openAlgoOrders', { symbol: this.symbol }, true);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.orders)) return data.orders;
    if (data && Array.isArray(data.algoOrders)) return data.algoOrders;
    return [];
  }

  async cancelAllOrders() {
    try {
      await this._request('DELETE', '/fapi/v1/algoOpenOrders', { symbol: this.symbol }, true);
    } catch { /* ignore */ }
    try {
      await this._request('DELETE', '/fapi/v1/allOpenOrders', { symbol: this.symbol }, true);
    } catch { /* ignore */ }
  }

  async getSlTpOrders() {
    const result = { stop_price: null, take_profit_price: null };
    try {
      const orders = await this.getOpenAlgoOrders();
      for (const order of orders) {
        const otype = order.type || order.origType || order.orderType;
        const trigger = parseFloat(order.triggerPrice || order.stopPrice || 0);
        if (trigger <= 0) continue;
        if (otype === 'STOP_MARKET') result.stop_price = trigger;
        else if (otype === 'TAKE_PROFIT_MARKET') result.take_profit_price = trigger;
      }
    } catch { /* ignore */ }
    return result;
  }

  async setSlTp(positionSide, stopPrice, takeProfitPrice, entryPrice = null) {
    await this.cancelAllOrders();
    let markPrice = null;
    try { markPrice = await this.getMarkPrice(); } catch { /* ignore */ }
    if (entryPrice != null) {
      const issues = validateSlTp(positionSide, entryPrice, stopPrice, takeProfitPrice, markPrice);
      if (issues.length) throw new Error(issues.join(' · '));
    }
    const errors = [];
    if (stopPrice && stopPrice > 0) {
      try {
        await this.placeStopMarket(positionSide, stopPrice);
      } catch (err) {
        errors.push(`SL: ${err.message}`);
      }
    }
    if (takeProfitPrice && takeProfitPrice > 0) {
      try {
        await this.placeTakeProfitMarket(positionSide, takeProfitPrice);
      } catch (err) {
        errors.push(`TP: ${err.message}`);
      }
    }
    const result = await this.getSlTpOrders();
    if (errors.length) throw new Error(errors.join(' · '));
    return result;
  }
}

module.exports = { BinanceFuturesClient };
