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
  }

  async function register(email, password) {
    const data = await FuturesApiClient.authRegister(email, password);
    setSession(data.access_token, data.user);
    return data;
  }

  async function login(email, password) {
    const data = await FuturesApiClient.authLogin(email, password);
    setSession(data.access_token, data.user);
    return data;
  }

  function logout() {
    clearSession();
  }

  function handleUnauthorized(message) {
    if (!getToken()) return;
    clearSession();
    if (typeof FuturesApiClient !== 'undefined') {
      FuturesApiClient.setConnected?.(false);
    }
    const statusEl = document.getElementById('authStatus');
    if (statusEl) {
      statusEl.textContent = message || '로그인 세션 만료 — 다시 로그인해 주세요';
    }
  }

  async function validateSession() {
    if (!authRequired || !getToken()) return false;
    try {
      await FuturesApiClient.authMe();
      return true;
    } catch {
      // 401 already clears the session via FuturesApiClient → handleUnauthorized.
      // Network errors keep the saved token so the user can retry.
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

  async function init() {
    if (initialized) return;
    initialized = true;
    syncUi();
    document.getElementById('authLoginBtn')?.addEventListener('click', async () => {
      const email = document.getElementById('authEmail')?.value?.trim();
      const password = document.getElementById('authPassword')?.value || '';
      if (!email || !password) {
        alert('이메일과 비밀번호를 입력하세요.');
        return;
      }
      try {
        await login(email, password);
        if (typeof FuturesBotApp !== 'undefined') {
          await FuturesBotApp.restoreSessionFromServer?.();
        }
      } catch (err) {
        alert(err.message || '로그인 실패');
      }
    });
    document.getElementById('authRegisterBtn')?.addEventListener('click', async () => {
      const email = document.getElementById('authEmail')?.value?.trim();
      const password = document.getElementById('authPassword')?.value || '';
      if (!email || password.length < 8) {
        alert('이메일과 비밀번호(8자 이상)를 입력하세요.');
        return;
      }
      try {
        await register(email, password);
        if (typeof FuturesBotApp !== 'undefined') {
          await FuturesBotApp.restoreSessionFromServer?.();
        }
      } catch (err) {
        alert(err.message || '회원가입 실패');
      }
    });
    document.getElementById('authLogoutBtn')?.addEventListener('click', () => {
      logout();
      FuturesApiClient.setConnected(false);
    });
  }

  return {
    init,
    getToken,
    isLoggedIn,
    isRequired,
    authHeaders,
    refreshFromHealth,
    handleUnauthorized,
    validateSession,
    logout,
  };
})();

window.AppAuth = AppAuth;

document.addEventListener('DOMContentLoaded', () => {
  AppAuth.init();
});
