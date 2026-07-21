/* [그룹2: API 서버 + 키 저장] — window.FuturesApiClient
 * 거래소 API 키는 이 모듈을 통해 서버에만 저장된다 (브라우저에 저장 안 함).
 * 다른 그룹은 이 모듈의 함수만 호출한다. 통신 오류는 의미 있는 정보이므로
 * 여기서 삼키지 않고 throw 하며, 호출한 쪽 try/catch가 사용자에게 보여준다. */
const FuturesApiClient = (() => {
  // Direct launch.py: web :8765 → API :8000.
  // Behind nginx/HTTPS (port 80/443 or https:): same-origin /api proxy.
  function resolveApiBase() {
    if (typeof window === 'undefined' || !window.location?.hostname) {
      return 'http://127.0.0.1:8000';
    }
    const { protocol, hostname, port } = window.location;
    if (protocol === 'https:' || !port || port === '443' || port === '80') {
      return '';
    }
    return `${protocol}//${hostname}:8000`;
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
    if (data?.message) return data.message;
    if (status === 401) return '이메일 또는 비밀번호가 올바르지 않습니다.';
    if (status === 403) return '접근이 거부되었습니다.';
    if (status === 404) return 'Not Found';
    if (status === 500 || status === 503) {
      return '서버 오류입니다. 잠시 후 다시 시도해 주세요.';
    }
    return `API error ${status}`;
  }

  function formatNotFoundHint(path, method) {
    return (
      `${method} ${path} → Not Found. ` +
      'API 서버가 구버전입니다. VPS SSH에서: cd ~/crypto-charts && git pull && sudo systemctl restart crypto-web'
    );
  }

  async function request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const authHdr = typeof AppAuth !== 'undefined' ? AppAuth.authHeaders() : {};
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...authHdr, ...options.headers },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) {
        const detail = formatApiError(data, res.status);
        // Only clear login for real auth/session failures — NOT Binance key errors.
        // (Invalid/missing exchange keys used to return 401 and logged users out.)
        const isSessionAuth = /로그인|세션이 만료|유효하지 않습니다|Login required|User not found/i.test(detail)
          && !/API key|API 키|Binance|바이낸스|saved|저장|connect first|IP|whitelist|권한/i.test(detail);
        if (
          isSessionAuth
          && typeof AppAuth !== 'undefined'
          && typeof AppAuth.handleUnauthorized === 'function'
        ) {
          AppAuth.handleUnauthorized(detail);
        }
        throw new Error(
          detail || '로그인 세션이 만료되었습니다. 다시 로그인한 뒤 시도해 주세요.',
        );
      }
      if (res.status === 429) {
        throw new Error(formatApiError(data, res.status) || '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
      }
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

  async function getPlatformOutboundIp() {
    return request('/api/platform/outbound-ip');
  }

  async function checkServer() {
    const data = await getHealth();
    return data?.ok === true;
  }

  async function connect(apiKey, apiSecret, useTestnet = null) {
    const payload = { api_key: apiKey, api_secret: apiSecret };
    if (useTestnet !== null && useTestnet !== undefined) {
      payload.use_testnet = Boolean(useTestnet);
    }
    const data = await request('/api/connect', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    connected = true;
    return data;
  }

  async function reconnect(useTestnet = null) {
    const payload = {};
    if (useTestnet !== null && useTestnet !== undefined) {
      payload.use_testnet = Boolean(useTestnet);
    }
    const data = await request('/api/reconnect', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
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
        stop_loss_pct: levels.stopLossPct ?? null,
        take_profit_pct: levels.takeProfitPct ?? null,
        use_stop_loss: levels.stopPrice != null,
      }),
    });
  }

  async function closePosition({ manual = false, barTime = null, blockedSignal = null } = {}) {
    return request('/api/order/close', {
      method: 'POST',
      body: JSON.stringify({
        manual,
        bar_time: barTime,
        blocked_signal: blockedSignal,
      }),
    });
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

  async function getStrategy() {
    return request('/api/strategy');
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

  async function startServerBot({ liveTrading = true } = {}) {
    return request('/api/bot/start', {
      method: 'POST',
      body: JSON.stringify({ live_trading: liveTrading }),
    });
  }

  async function stopServerBot() {
    return request('/api/bot/stop', { method: 'POST' });
  }

  async function pauseBotEntry() {
    return request('/api/bot/pause-entry', { method: 'POST' });
  }

  async function clearBotEntryPause() {
    return request('/api/bot/clear-entry-pause', { method: 'POST' });
  }

  async function authRegister(email, password, acceptTerms = false) {
    return request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, accept_terms: Boolean(acceptTerms) }),
    });
  }

  async function authLogin(email, password) {
    return request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  async function authMe() {
    return request('/api/auth/me');
  }

  async function authVerifyEmail(token) {
    return request('/api/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  }

  async function authResendVerification(email) {
    return request('/api/auth/resend-verification', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  async function authForgotPassword(email) {
    return request('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  async function authResetPassword(token, password) {
    return request('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  }

  async function billingMe() {
    return request('/api/billing/me');
  }

  async function billingStatus() {
    return request('/api/billing/status');
  }

  async function billingPrepare() {
    return request('/api/billing/prepare', { method: 'POST', body: '{}' });
  }

  async function billingConfirm({ authKey, customerKey }) {
    return request('/api/billing/confirm', {
      method: 'POST',
      body: JSON.stringify({ authKey, customerKey }),
    });
  }

  async function billingCancel({ immediate = false } = {}) {
    return request('/api/billing/cancel', {
      method: 'POST',
      body: JSON.stringify({ immediate }),
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
    getHealth,
    getPlatformOutboundIp,
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
    getStrategy,
    syncStrategy,
    getBotStatus,
    startServerBot,
    stopServerBot,
    pauseBotEntry,
    clearBotEntryPause,
    authRegister,
    authLogin,
    authMe,
    authVerifyEmail,
    authResendVerification,
    authForgotPassword,
    authResetPassword,
    billingMe,
    billingStatus,
    billingPrepare,
    billingConfirm,
    billingCancel,
    isConnected,
    setConnected,
  };
})();

window.FuturesApiClient = FuturesApiClient;
