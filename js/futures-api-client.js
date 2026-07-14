/* Local API client for Binance Futures Testnet */
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
    return data?.message || `API error ${status}`;
  }

  async function request(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(formatApiError(data, res.status));
    }
    return data;
  }

  async function checkServer() {
    try {
      const data = await request('/api/health');
      return data.ok === true;
    } catch {
      return false;
    }
  }

  async function connect(apiKey, apiSecret) {
    const data = await request('/api/connect', {
      method: 'POST',
      body: JSON.stringify({ api_key: apiKey, api_secret: apiSecret }),
    });
    connected = true;
    return data;
  }

  async function disconnect() {
    await request('/api/disconnect', { method: 'POST' });
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

  async function openPosition(side, marginUsdt, leverage, price) {
    return request('/api/order/open', {
      method: 'POST',
      body: JSON.stringify({
        side,
        margin_usdt: marginUsdt,
        leverage,
        price,
      }),
    });
  }

  async function closePosition() {
    return request('/api/order/close', { method: 'POST' });
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

  async function interpretStrategy(prompt, currentSettings, history = []) {
    return request('/api/strategy/interpret', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        current_settings: currentSettings,
        history,
      }),
    });
  }

  async function configureOpenAiKey(openaiApiKey) {
    return request('/api/strategy/configure', {
      method: 'POST',
      body: JSON.stringify({ openai_api_key: openaiApiKey }),
    });
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
    connect,
    disconnect,
    getStatus,
    setup,
    openPosition,
    closePosition,
    getStrategyAiStatus,
    testOpenAiKey,
    interpretStrategy,
    configureOpenAiKey,
    isConnected,
    setConnected,
  };
})();

window.FuturesApiClient = FuturesApiClient;
