/* [그룹2: API 서버 + 키 저장] — window.FuturesApiClient
 * 거래소 API 키는 이 모듈을 통해 서버에만 저장된다 (브라우저에 저장 안 함).
 * 다른 그룹은 이 모듈의 함수만 호출한다. 통신 오류는 의미 있는 정보이므로
 * 여기서 삼키지 않고 throw 하며, 호출한 쪽 try/catch가 사용자에게 보여준다. */
const FuturesApiClient = (() => {
  // Same host as the page, port 8000 — works on localhost and on a remote VPS
  // (http://<server-ip>:8765 → API http://<server-ip>:8000).
  function resolveApiBase() {
    if (typeof window !== 'undefined' && window.location?.hostname) {
      const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
      return `${protocol}//${window.location.hostname}:8000`;
    }
    return 'http://127.0.0.1:8000';
  }
  const API_BASE = resolveApiBase();
  let connected = false;

  function formatApiError(data, status) {
    const detail = data?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail.map((item) => item?.msg || JSON.stringify(item)).join('\n');
    }
    if (detail && typeof detail === 'object') {
      return detail.message || JSON.stringify(detail);
    }
    return data?.message || (status === 404 ? 'Not Found' : `API error ${status}`);
  }

  function formatNotFoundHint(path, method) {
    return (
      `${method} ${path} → Not Found. ` +
      'API 서버가 구버전입니다. VPS SSH에서: cd ~/crypto-charts && git pull && sudo systemctl restart crypto-web'
    );
  }

  async function request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(formatNotFoundHint(path, method));
      }
      throw new Error(formatApiError(data, res.status));
    }
    return data;
  }

  async function getHealth() {
    try {
      return await request('/api/health');
    } catch {
      return null;
    }
  }

  async function checkServer() {
    const data = await getHealth();
    return data?.ok === true;
  }

  async function connect(apiKey, apiSecret) {
    const data = await request('/api/connect', {
      method: 'POST',
      body: JSON.stringify({ api_key: apiKey, api_secret: apiSecret }),
    });
    connected = true;
    return data;
  }

  async function reconnect() {
    const data = await request('/api/reconnect', { method: 'POST' });
    connected = true;
    return data;
  }

  async function disconnect(clearSavedKeys = false) {
    await request('/api/disconnect', {
      method: 'POST',
      body: JSON.stringify({ clear_saved_keys: clearSavedKeys }),
    });
    connected = false;
  }

  async function getStatus() {
    return request('/api/status');
  }

  async function setup({ leverage, marginType, symbol, tradeMarginUsdt }) {
    return request('/api/setup', {
      method: 'POST',
      body: JSON.stringify({
        leverage,
        margin_type: marginType || 'ISOLATED',
        symbol: symbol || 'BTCUSDT',
        trade_margin_usdt: tradeMarginUsdt,
      }),
    });
  }

  async function openPosition(side, marginUsdt, leverage, price, levels = {}) {
    return request('/api/order/open', {
      method: 'POST',
      body: JSON.stringify({
        side,
        margin_usdt: marginUsdt,
        leverage,
        price,
        stop_price: levels.stopPrice ?? null,
        take_profit_price: levels.takeProfitPrice ?? null,
      }),
    });
  }

  async function closePosition() {
    return request('/api/order/close', { method: 'POST' });
  }

  // Replace exchange-side SL/TP trigger orders for the open position.
  async function setSlTp(stopPrice, takeProfitPrice) {
    return request('/api/order/sltp', {
      method: 'POST',
      body: JSON.stringify({
        stop_price: stopPrice ?? null,
        take_profit_price: takeProfitPrice ?? null,
      }),
    });
  }

  async function getStrategyAiStatus(verify = false) {
    const query = verify ? '?verify=true' : '';
    return request(`/api/strategy/ai-status${query}`);
  }

  async function testOpenAiKey(openaiApiKey = null) {
    const body = openaiApiKey ? { openai_api_key: openaiApiKey } : {};
    return request('/api/strategy/test-key', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async function interpretStrategy(prompt, currentSettings, history = [], options = {}) {
    return request('/api/strategy/interpret', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        current_settings: currentSettings,
        history,
        symbol: options.symbol || 'BTCUSDT',
        interval: options.interval || '1h',
        market_context: options.marketContext || null,
        backtest_snapshot: options.backtestSnapshot || null,
      }),
    });
  }

  async function getStrategyAiHistory() {
    return request('/api/strategy/ai-history');
  }

  async function clearStrategyAiHistory() {
    return request('/api/strategy/ai-history/clear', { method: 'POST' });
  }

  async function configureOpenAiKey(openaiApiKey) {
    return request('/api/strategy/configure', {
      method: 'POST',
      body: JSON.stringify({ openai_api_key: openaiApiKey }),
    });
  }

  async function syncStrategy(strategy) {
    return request('/api/strategy/sync', {
      method: 'POST',
      body: JSON.stringify({ strategy }),
    });
  }

  async function getBotStatus() {
    return request('/api/bot/status');
  }

  async function startServerBot() {
    return request('/api/bot/start', { method: 'POST' });
  }

  async function stopServerBot() {
    return request('/api/bot/stop', { method: 'POST' });
  }

  function isConnected() {
    return connected;
  }

  function setConnected(value) {
    connected = value;
  }

  return {
    API_BASE,
    checkServer,
    getHealth,
    connect,
    reconnect,
    disconnect,
    getStatus,
    setup,
    openPosition,
    closePosition,
    setSlTp,
    getStrategyAiStatus,
    testOpenAiKey,
    interpretStrategy,
    getStrategyAiHistory,
    clearStrategyAiHistory,
    configureOpenAiKey,
    syncStrategy,
    getBotStatus,
    startServerBot,
    stopServerBot,
    isConnected,
    setConnected,
  };
})();

window.FuturesApiClient = FuturesApiClient;
