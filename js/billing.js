/* Toss Payments billing-key subscription UI */
const AppBilling = (() => {
  let lastSnap = null;
  let busy = false;

  function $(id) {
    return document.getElementById(id);
  }

  function render(snap) {
    lastSnap = snap;
    const box = $('billingPanel');
    if (!box) return;

    const loggedIn = typeof AppAuth !== 'undefined' && AppAuth.isLoggedIn();
    // On dedicated billing page the panel sits inside #authLoggedIn; keep it visible when logged in.
    box.classList.toggle('hidden', !loggedIn);
    if (!loggedIn) return;

    const planEl = $('billingPlanLabel');
    const botEl = $('billingBotQuota');
    const gptEl = $('billingGptQuota');
    const noteEl = $('billingNote');
    const upgradeBtn = $('billingUpgradeBtn');
    const cancelBtn = $('billingCancelBtn');

    if (!snap) {
      if (planEl) planEl.textContent = '—';
      if (botEl) botEl.textContent = '불러오는 중…';
      if (gptEl) gptEl.textContent = '—';
      return;
    }

    if (planEl) {
      planEl.textContent = snap.pro ? 'Pro' : 'Free';
      planEl.classList.toggle('is-pro', !!snap.pro);
    }

    if (botEl) {
      botEl.textContent = snap.pro
        ? '봇 가동: 무제한'
        : `봇 가동: ${snap.bot?.hoursUsed ?? 0} / ${snap.bot?.hoursLimit ?? 48}시간 (이번 주)`;
    }

    if (gptEl) {
      gptEl.textContent = snap.pro
        ? 'GPT: Pro (hybrid)'
        : `GPT: ${snap.gpt?.callsUsed ?? 0} / ${snap.gpt?.callsLimit ?? 20}회 (이번 주 · mini)`;
    }

    if (noteEl) {
      if (!snap.paymentsConfigured) {
        noteEl.textContent = '결제(토스페이먼츠)가 아직 서버에 설정되지 않았습니다.';
      } else if (!snap.enforce) {
        noteEl.textContent = '쿼터 강제 적용이 꺼져 있습니다 (BILLING_ENFORCE).';
      } else if (snap.pro && snap.cancelAtPeriodEnd) {
        noteEl.textContent = snap.currentPeriodEnd
          ? `해지 예약됨 · ${new Date(snap.currentPeriodEnd).toLocaleString()}까지 Pro`
          : '해지 예약됨 · 기간 종료 후 Free';
      } else if (snap.pro) {
        const won = Number(snap.amountKrw || 0).toLocaleString('ko-KR');
        noteEl.textContent = snap.currentPeriodEnd
          ? `Pro 월 ${won}원 · 다음 결제일 ${new Date(snap.currentPeriodEnd).toLocaleDateString('ko-KR')}`
          : `Pro 월 ${won}원 구독 중`;
      } else {
        const won = Number(snap.amountKrw || 29000).toLocaleString('ko-KR');
        noteEl.textContent = `무료: 주 48시간 봇 · GPT 20회. Pro 월 ${won}원.`;
      }
    }

    if (upgradeBtn) {
      upgradeBtn.classList.toggle('hidden', !!snap.pro || !snap.paymentsConfigured);
      upgradeBtn.disabled = busy;
    }
    if (cancelBtn) {
      cancelBtn.classList.toggle('hidden', !snap.pro);
      cancelBtn.disabled = busy || !!snap.cancelAtPeriodEnd;
      cancelBtn.textContent = snap.cancelAtPeriodEnd ? '해지 예약됨' : '구독 해지';
    }
  }

  async function refresh() {
    if (typeof AppAuth === 'undefined' || !AppAuth.isLoggedIn()) {
      render(null);
      $('billingPanel')?.classList.add('hidden');
      return null;
    }
    try {
      const data = await FuturesApiClient.billingMe();
      render(data);
      return data;
    } catch (err) {
      const noteEl = $('billingNote');
      if (noteEl) noteEl.textContent = err.message || '구독 정보를 불러오지 못했습니다.';
      return null;
    }
  }

  function loadTossSdk() {
    return new Promise((resolve, reject) => {
      if (typeof window.TossPayments === 'function') {
        resolve(window.TossPayments);
        return;
      }
      const existing = document.querySelector('script[data-toss-sdk]');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.TossPayments));
        existing.addEventListener('error', () => reject(new Error('토스 SDK 로드 실패')));
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://js.tosspayments.com/v2/standard';
      s.async = true;
      s.dataset.tossSdk = '1';
      s.onload = () => resolve(window.TossPayments);
      s.onerror = () => reject(new Error('토스 SDK 로드 실패'));
      document.head.appendChild(s);
    });
  }

  async function startCheckout() {
    if (busy) return;
    busy = true;
    render(lastSnap);
    try {
      const prep = await FuturesApiClient.billingPrepare();
      const TossPayments = await loadTossSdk();
      const tossPayments = TossPayments(prep.clientKey);
      const payment = tossPayments.payment({ customerKey: prep.customerKey });
      await payment.requestBillingAuth({
        method: 'CARD',
        successUrl: prep.successUrl,
        failUrl: prep.failUrl,
        customerEmail: prep.customerEmail,
        customerName: prep.customerName,
      });
    } catch (err) {
      alert(err.message || '결제창을 열지 못했습니다.');
    } finally {
      busy = false;
      render(lastSnap);
    }
  }

  async function cancelSubscription() {
    if (busy) return;
    if (!confirm('기간이 끝나면 Free로 전환됩니다. 구독을 해지할까요?')) return;
    busy = true;
    render(lastSnap);
    try {
      const data = await FuturesApiClient.billingCancel({ immediate: false });
      alert(data.message || '해지가 예약되었습니다.');
      await refresh();
    } catch (err) {
      alert(err.message || '해지 실패');
    } finally {
      busy = false;
      render(lastSnap);
    }
  }

  async function handleReturnQuery() {
    const params = new URLSearchParams(window.location.search);
    const billing = params.get('billing');
    if (!billing) return;

    const noteEl = $('billingNote');
    if (billing === 'fail') {
      if (noteEl) {
        noteEl.textContent = params.get('message') || '카드 등록이 취소되거나 실패했습니다.';
      }
    } else if (billing === 'success') {
      const authKey = params.get('authKey');
      const customerKey = params.get('customerKey');
      if (noteEl) noteEl.textContent = '결제 확인 중…';
      if (authKey && customerKey && typeof AppAuth !== 'undefined' && AppAuth.isLoggedIn()) {
        try {
          busy = true;
          await FuturesApiClient.billingConfirm({ authKey, customerKey });
          if (noteEl) noteEl.textContent = 'Pro 구독이 활성화되었습니다.';
          await refresh();
        } catch (err) {
          if (noteEl) noteEl.textContent = err.message || '결제 확정 실패';
          alert(err.message || '결제 확정 실패');
        } finally {
          busy = false;
        }
      }
    }

    params.delete('billing');
    params.delete('authKey');
    params.delete('customerKey');
    params.delete('code');
    params.delete('message');
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', next);
  }

  function init() {
    $('billingUpgradeBtn')?.addEventListener('click', () => startCheckout());
    $('billingCancelBtn')?.addEventListener('click', () => cancelSubscription());
    handleReturnQuery().then(() => refresh());
  }

  return {
    init,
    refresh,
    getSnapshot: () => lastSnap,
  };
})();

window.AppBilling = AppBilling;

document.addEventListener('DOMContentLoaded', () => {
  AppBilling.init();
});
