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
    }
    if (typeof StrategyAI !== 'undefined') {
      StrategyAI.resetForAccountSwitch?.();
      StrategyAI.refreshStatus?.({ verify: false });
    }
  }

  function logout() {
    clearSession();
    clearTradingState();
  }

  function handleUnauthorized(message) {
    if (!getToken()) return;
    clearSession();
    clearTradingState();
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
    }
    if (typeof StrategyAI !== 'undefined') {
      await StrategyAI.reloadForUser?.();
    }
    if (typeof AppBilling !== 'undefined') {
      await AppBilling.refresh?.();
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
        clearTradingState();
        await login(email, password);
        await afterLoginHooks();
      } catch (err) {
        alert(err.message || '로그인 실패');
      }
    });
    document.getElementById('authRegisterBtn')?.addEventListener('click', async () => {
      const email = document.getElementById('authEmail')?.value?.trim();
      const password = document.getElementById('authPassword')?.value || '';
      const acceptTerms = Boolean(document.getElementById('authAcceptTerms')?.checked);
      if (!email || password.length < 8) {
        alert('이메일과 비밀번호(8자 이상)를 입력하세요.');
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
          alert(data.message || '가입되었습니다. 이메일 인증 링크를 확인해 주세요.');
          const statusEl = document.getElementById('authStatus');
          if (statusEl) statusEl.textContent = '이메일 인증 대기 중';
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
        alert(data.message || '인증 메일을 보냈습니다.');
      } catch (err) {
        alert(err.message || '요청 실패');
      }
    });
    document.getElementById('authLogoutBtn')?.addEventListener('click', () => {
      logout();
      if (typeof AppBilling !== 'undefined') {
        AppBilling.refresh?.();
      }
    });
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
  };
})();

window.AppAuth = AppAuth;

document.addEventListener('DOMContentLoaded', () => {
  AppAuth.init();
});
