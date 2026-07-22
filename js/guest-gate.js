/* Guest (not logged in): chart viewing OK, all other product features locked. */
const GuestGate = (() => {
  const NOTICE_KEY = 'orbinex-guest-notice-v1';

  function authOn() {
    return typeof AppAuth !== 'undefined' && AppAuth.isRequired?.();
  }

  function isGuest() {
    if (!authOn()) return false;
    return !AppAuth.isLoggedIn?.();
  }

  function loginUrl(next) {
    if (typeof AppAuth !== 'undefined' && AppAuth.loginPageUrl) {
      return AppAuth.loginPageUrl(next || 'trading.html');
    }
    const n = encodeURIComponent(next || 'trading.html');
    return `login.html?next=${n}`;
  }

  function currentPage() {
    return (location.pathname || '').split('/').pop() || 'index.html';
  }

  function goLogin() {
    if (typeof AppAuth !== 'undefined' && AppAuth.redirectToLogin) {
      AppAuth.redirectToLogin(currentPage());
    } else {
      location.href = loginUrl(currentPage());
    }
  }

  async function promptLogin(feature) {
    const label = feature ? `「${feature}」` : '이 기능';
    const message = `${label}은(는) 로그인이 필요합니다.\n로그인 페이지로 이동할까요?`;
    let go = false;
    if (typeof UiModal !== 'undefined') {
      go = await UiModal.confirm(message, {
        title: '로그인 필요',
        confirmText: '로그인',
        cancelText: '나중에',
      });
    } else {
      go = window.confirm(message);
    }
    if (go) goLogin();
    return false;
  }

  /** @returns {boolean} true if allowed to proceed */
  function requireLogin(feature) {
    if (!isGuest()) return true;
    promptLogin(feature);
    return false;
  }

  async function showGuestWelcome() {
    if (!isGuest()) return;
    try {
      if (sessionStorage.getItem(NOTICE_KEY)) return;
      sessionStorage.setItem(NOTICE_KEY, '1');
    } catch { /* private mode */ }

    const page = currentPage();
    const isTrading = page === 'trading.html';
    const message = isTrading
      ? '비로그인 상태에서는 차트만 볼 수 있습니다.\n자동매매·봇·AI·API 연결은 로그인 후 이용할 수 있습니다.'
      : '비로그인 상태에서는 차트만 볼 수 있습니다.\nAI·모의매매 등 다른 기능은 로그인 후 이용할 수 있습니다.';

    if (typeof UiModal === 'undefined') return;
    const go = await UiModal.open({
      title: '차트 미리보기',
      message,
      confirmText: '로그인',
      cancelText: '차트로 계속',
    });
    if (go) goLogin();
  }

  function syncTradingGuestUi() {
    const guest = isGuest();
    document.body.classList.toggle('trading-page--guest', guest);
    const authStatus = document.getElementById('authStatus');
    if (guest && authStatus) {
      authStatus.textContent = '차트만 이용 중 — 자동매매는 로그인 필요';
    }
  }

  function syncIndexGuestUi() {
    const guest = isGuest();
    document.body.classList.toggle('chart-page--guest', guest);
    const aiBtn = document.getElementById('aiToggleBtn');
    if (aiBtn) {
      aiBtn.title = guest ? '로그인 후 AI 이용' : 'AI 어시스턴트 (/)';
      aiBtn.classList.toggle('ai-toggle-btn--locked', guest);
    }
  }

  function bindIndexLocks() {
    document.getElementById('aiToggleBtn')?.addEventListener('click', (e) => {
      if (!isGuest()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      promptLogin('AI 어시스턴트');
    }, true);

    document.addEventListener('keydown', (e) => {
      if (!isGuest()) return;
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        promptLogin('AI 어시스턴트');
      }
    }, true);
  }

  function bindTradingLocks() {
    document.addEventListener('click', (e) => {
      if (!isGuest()) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('#uiModalRoot, #authSection, .header__nav, .header__brand')) return;
      if (t.closest('.trading-chart-zone') && !t.closest('.chart-ai-panel, #backtestPopup, #strategyAiSendBtn, #strategyAiInput')) {
        return;
      }
      if (
        t.closest('.bot-control-panel')
        || t.closest('.chart-ai-panel')
        || t.closest('#backtestPopup')
        || t.closest('#backtestToggleBtn')
        || t.closest('#runBacktestBtn')
      ) {
        if (t.closest('#authSection')) return;
        e.preventDefault();
        e.stopPropagation();
        promptLogin('자동매매 기능');
      }
    }, true);
  }

  async function bootIndex() {
    if (typeof AppAuth === 'undefined' || typeof FuturesApiClient === 'undefined') {
      syncIndexGuestUi();
      return;
    }
    try {
      await AppAuth.init?.();
      const health = await FuturesApiClient.getHealth();
      await AppAuth.refreshFromHealth?.(health);
    } catch { /* ignore */ }
    syncIndexGuestUi();
    bindIndexLocks();
    await showGuestWelcome();
  }

  async function afterTradingGuestReady() {
    syncTradingGuestUi();
    await showGuestWelcome();
  }

  return {
    isGuest,
    requireLogin,
    promptLogin,
    syncTradingGuestUi,
    syncIndexGuestUi,
    bindTradingLocks,
    bootIndex,
    afterTradingGuestReady,
    showGuestWelcome,
  };
})();

window.GuestGate = GuestGate;
