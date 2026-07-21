/* Guest (not logged in): chart viewing OK, all other product features locked. */
const GuestGate = (() => {
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

  function promptLogin(feature) {
    const label = feature ? `「${feature}」` : '이 기능';
    const go = confirm(`${label}은(는) 로그인이 필요합니다.\n로그인 페이지로 이동할까요?`);
    if (go) {
      if (typeof AppAuth !== 'undefined' && AppAuth.redirectToLogin) {
        AppAuth.redirectToLogin(currentPage());
      } else {
        location.href = loginUrl(currentPage());
      }
    }
    return false;
  }

  function currentPage() {
    return (location.pathname || '').split('/').pop() || 'index.html';
  }

  /** @returns {boolean} true if allowed to proceed */
  function requireLogin(feature) {
    if (!isGuest()) return true;
    promptLogin(feature);
    return false;
  }

  function syncTradingGuestUi() {
    const guest = isGuest();
    document.body.classList.toggle('trading-page--guest', guest);
    const banner = document.getElementById('guestChartBanner');
    if (banner) banner.classList.toggle('hidden', !guest);
    const authStatus = document.getElementById('authStatus');
    if (guest && authStatus && !authStatus.dataset.guestSet) {
      authStatus.textContent = '차트만 이용 중 — 자동매매·봇·GPT는 로그인 필요';
    }
  }

  function syncIndexGuestUi() {
    const guest = isGuest();
    document.body.classList.toggle('chart-page--guest', guest);
    const banner = document.getElementById('guestChartBanner');
    if (banner) banner.classList.toggle('hidden', !guest);
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
    // Capture clicks on locked regions
    document.addEventListener('click', (e) => {
      if (!isGuest()) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('#guestChartBanner a, #authSection, .header__nav, .header__brand')) return;
      if (t.closest('.trading-chart-zone') && !t.closest('.chart-ai-panel, #backtestPopup, #strategyAiSendBtn, #strategyAiInput')) {
        // chart interactions OK
        return;
      }
      if (
        t.closest('.bot-control-panel')
        || t.closest('.chart-ai-panel')
        || t.closest('#backtestPopup')
        || t.closest('#backtestToggleBtn')
        || t.closest('#runBacktestBtn')
      ) {
        // Allow account section interactions
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
  }

  return {
    isGuest,
    requireLogin,
    promptLogin,
    syncTradingGuestUi,
    syncIndexGuestUi,
    bindTradingLocks,
    bootIndex,
  };
})();

window.GuestGate = GuestGate;
