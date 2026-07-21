const AppAuth = (() => {
  const TOKEN_KEY = 'crypto-charts-auth-token';
  const USER_KEY = 'crypto-charts-auth-user';
  let authRequired = false;
  let initialized = false;

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setSession(token, user) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
    syncUi();
  }

  function clearSession() {
    setSession('', null);
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function isLoggedIn() {
    return Boolean(getToken());
  }

  function isRequired() {
    return authRequired;
  }

  function authHeaders() {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function currentPageName() {
    const path = window.location.pathname || '';
    const name = path.split('/').pop() || 'index.html';
    return name.includes('.') ? name : 'index.html';
  }

  function safeNextPath(raw) {
    if (!raw) return '';
    try {
      const u = new URL(String(raw), window.location.origin);
      if (u.origin !== window.location.origin) return '';
      let path = u.pathname.replace(/^\//, '');
      if (!path || path.endsWith('/')) path = `${path}index.html`;
      if (!/\.html$/i.test(path.split('?')[0])) return '';
      if (path.includes('..')) return '';
      return `${path}${u.search}${u.hash}`;
    } catch {
      return '';
    }
  }

  function loginPageUrl(next) {
    const target = safeNextPath(next) || currentPageName() + window.location.search;
    return `login.html?next=${encodeURIComponent(target)}`;
  }

  function redirectToLogin(next) {
    window.location.href = loginPageUrl(next);
  }

  function redirectAfterAuth() {
    const params = new URLSearchParams(window.location.search);
    const next = safeNextPath(params.get('next')) || 'trading.html';
    window.location.href = next;
  }

  function syncUi() {
    const loggedIn = isLoggedIn();
    document.getElementById('authLoggedOut')?.classList.toggle('hidden', loggedIn);
    document.getElementById('authLoggedIn')?.classList.toggle('hidden', !loggedIn);
    const userEl = document.getElementById('authUserEmail');
    if (userEl) userEl.textContent = getUser()?.email || '—';
    const statusEl = document.getElementById('authStatus');
    if (statusEl) {
      if (!authRequired) statusEl.textContent = '로그인 비활성 (AUTH_REQUIRED=false)';
      else if (loggedIn) statusEl.textContent = '로그인됨';
      else statusEl.textContent = '로그인 필요';
    }
    const loginLink = document.getElementById('authLoginPageLink');
    if (loginLink) loginLink.href = loginPageUrl('trading.html');
  }

  async function register(email, password, acceptTerms) {
    const data = await FuturesApiClient.authRegister(email, password, acceptTerms);
    if (data.access_token) setSession(data.access_token, data.user);
    else clearSession();
    return data;
  }

  async function login(email, password) {
    const data = await FuturesApiClient.authLogin(email, password);
    setSession(data.access_token, data.user);
    return data;
  }

  function clearTradingState() {
    if (typeof FuturesApiClient !== 'undefined') {
      FuturesApiClient.setConnected?.(false);
    }
    if (typeof FuturesBotApp !== 'undefined') {
      FuturesBotApp.resetClientSessionState?.({ keepLog: false });
      FuturesBotApp.refreshPlanFeatures?.();
    }
    if (typeof StrategyAI !== 'undefined') {
      StrategyAI.resetForAccountSwitch?.();
      StrategyAI.refreshStatus?.({ verify: false });
      StrategyAI.syncPlanGates?.();
    }
  }

  function logout() {
    clearSession();
    clearTradingState();
    if (typeof AppBilling !== 'undefined') {
      AppBilling.refresh?.();
    }
    const page = currentPageName();
    if (page === 'billing.html' || page === 'login.html' || page === 'register.html') {
      window.location.href = 'login.html';
    }
  }

  function handleUnauthorized(message) {
    if (!getToken()) return;
    clearSession();
    clearTradingState();
    const statusEl = document.getElementById('authStatus');
    if (statusEl) {
      statusEl.textContent = message || '로그인 세션 만료 — 다시 로그인해 주세요';
    }
    const page = currentPageName();
    if (page === 'trading.html' || page === 'billing.html') {
      redirectToLogin(page);
    }
  }

  async function validateSession() {
    if (!authRequired || !getToken()) return false;
    try {
      await FuturesApiClient.authMe();
      return true;
    } catch {
      return Boolean(getToken());
    }
  }

  async function refreshFromHealth(health) {
    authRequired = health?.authRequired === true;
    syncUi();
    if (authRequired && getToken()) {
      await validateSession();
    }
  }

  async function afterLoginHooks() {
    if (typeof FuturesBotApp !== 'undefined') {
      await FuturesBotApp.restoreSessionFromServer?.();
      await FuturesBotApp.restoreStrategyPersistence?.();
      await FuturesBotApp.refreshPlanFeatures?.();
    }
    if (typeof StrategyAI !== 'undefined') {
      await StrategyAI.reloadForUser?.();
      StrategyAI.syncPlanGates?.();
    }
    if (typeof AppBilling !== 'undefined') {
      await AppBilling.refresh?.();
    }
  }

  function bindFormHandlers() {
    document.getElementById('authLoginBtn')?.addEventListener('click', async () => {
      const email = document.getElementById('authEmail')?.value?.trim();
      const password = document.getElementById('authPassword')?.value || '';
      if (!email || !password) {
        alert('이메일과 비밀번호를 입력하세요.');
        return;
      }
      try {
        clearTradingState();
        await login(email, password);
        if (currentPageName() === 'login.html') {
          redirectAfterAuth();
          return;
        }
        await afterLoginHooks();
      } catch (err) {
        alert(err.message || '로그인 실패');
      }
    });
    document.getElementById('authRegisterBtn')?.addEventListener('click', async () => {
      const email = document.getElementById('authEmail')?.value?.trim();
      const password = document.getElementById('authPassword')?.value || '';
      const passwordConfirm = document.getElementById('authPasswordConfirm')?.value;
      const acceptTerms = Boolean(document.getElementById('authAcceptTerms')?.checked);
      if (!email || password.length < 8) {
        alert('이메일과 비밀번호(8자 이상)를 입력하세요.');
        return;
      }
      if (passwordConfirm !== undefined && password !== passwordConfirm) {
        alert('비밀번호가 일치하지 않습니다.');
        return;
      }
      if (!acceptTerms) {
        alert('이용약관·개인정보·위험고지에 동의해 주세요.');
        return;
      }
      try {
        clearTradingState();
        const data = await register(email, password, acceptTerms);
        if (data.needsVerification) {
          alert(data.message || data.emailError || '가입되었습니다. 이메일 인증 링크를 확인해 주세요.');
          const statusEl = document.getElementById('authStatus');
          if (statusEl) statusEl.textContent = '이메일 인증 대기 중 — 메일을 확인하세요';
          const loginQs = new URLSearchParams();
          loginQs.set('email', email);
          window.location.href = `login.html?${loginQs.toString()}`;
          return;
        }
        if (currentPageName() === 'login.html' || currentPageName() === 'register.html') {
          redirectAfterAuth();
          return;
        }
        await afterLoginHooks();
      } catch (err) {
        alert(err.message || '회원가입 실패');
      }
    });
    document.getElementById('authForgotBtn')?.addEventListener('click', async () => {
      const email = document.getElementById('authEmail')?.value?.trim();
      if (!email) {
        alert('가입한 이메일을 입력한 뒤 다시 눌러 주세요.');
        return;
      }
      try {
        const data = await FuturesApiClient.authForgotPassword(email);
        alert(data.message || '재설정 안내를 보냈습니다.');
      } catch (err) {
        alert(err.message || '요청 실패');
      }
    });
    document.getElementById('authResendVerifyBtn')?.addEventListener('click', async () => {
      const email = document.getElementById('authEmail')?.value?.trim();
      if (!email) {
        alert('이메일을 입력한 뒤 다시 눌러 주세요.');
        return;
      }
      try {
        const data = await FuturesApiClient.authResendVerification(email);
        alert(data.message || '인증 메일을 보냈습니다. 받은편지함·스팸함·프로모션함을 확인해 주세요.');
      } catch (err) {
        alert(err.message || '요청 실패');
      }
    });
    document.getElementById('authLogoutBtn')?.addEventListener('click', () => {
      logout();
    });
  }

  async function init() {
    if (initialized) return;
    initialized = true;
    syncUi();
    bindFormHandlers();
  }

  async function loadHealthAndSync() {
    try {
      const health = await FuturesApiClient.getHealth();
      await refreshFromHealth(health);
      return health;
    } catch {
      await refreshFromHealth({ authRequired: true });
      return null;
    }
  }

  async function bootLoginPage() {
    await init();
    await loadHealthAndSync();
    const params = new URLSearchParams(window.location.search);
    const email = params.get('email');
    if (email && document.getElementById('authEmail')) {
      document.getElementById('authEmail').value = email;
    }
    const reg = document.getElementById('registerPageLink');
    if (reg) {
      const next = params.get('next');
      reg.href = next ? `register.html?next=${encodeURIComponent(next)}` : 'register.html';
    }
    if (isLoggedIn() && authRequired) {
      if (params.get('next')) redirectAfterAuth();
    }
  }

  async function bootRegisterPage() {
    await init();
    await loadHealthAndSync();
    if (isLoggedIn() && authRequired) {
      const params = new URLSearchParams(window.location.search);
      if (params.get('next')) redirectAfterAuth();
      else window.location.href = 'trading.html';
    }
  }

  async function bootBillingPage() {
    await init();
    await loadHealthAndSync();
    if (authRequired && !isLoggedIn()) {
      syncUi();
      return;
    }
    if (typeof AppBilling !== 'undefined') {
      await AppBilling.refresh?.();
    }
  }

  return {
    init,
    getToken,
    getUser,
    setSession,
    isLoggedIn,
    isRequired,
    authHeaders,
    refreshFromHealth,
    handleUnauthorized,
    validateSession,
    logout,
    redirectToLogin,
    loginPageUrl,
    bootLoginPage,
    bootRegisterPage,
    bootBillingPage,
  };
})();

window.AppAuth = AppAuth;

document.addEventListener('DOMContentLoaded', () => {
  // login/register/billing pages call boot* explicitly; trading still uses init via FuturesBotApp
  const page = (window.location.pathname || '').split('/').pop() || '';
  if (page !== 'login.html' && page !== 'register.html' && page !== 'billing.html') {
    AppAuth.init();
  }
});
