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
        ? 'GPT: Pro (hybrid · 웹 리서치)'
        : `GPT: ${snap.gpt?.callsUsed ?? 0} / ${snap.gpt?.callsLimit ?? 10}회 (이번 주 · mini)`;
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
        const botH = snap.bot?.hoursLimit ?? 48;
        const gptN = snap.gpt?.callsLimit ?? 10;
        const slots = snap.features?.maxStrategySlots ?? 1;
        noteEl.textContent = `무료: 주 ${botH}시간 봇 · GPT ${gptN}회(mini) · 슬롯 ${slots}개 · 추천/리서치 없음. Pro는 무제한·멀티슬롯·추천 · 월 ${won}원.`;
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

  async function renderHistory() {
    const el = $('billingHistory');
    if (!el || typeof FuturesApiClient.billingHistory !== 'function') return;
    try {
      const data = await FuturesApiClient.billingHistory();
      const rows = data.payments || [];
      if (!rows.length) {
        el.textContent = '결제 내역이 없습니다.';
        return;
      }
      el.innerHTML = `<ul style="list-style:none;padding:0;margin:0;font-size:0.86rem;">${rows.map((p) => {
        const when = p.createdAt ? new Date(p.createdAt).toLocaleString('ko-KR') : '—';
        const amt = Number(p.amount || 0).toLocaleString('ko-KR');
        const kind = p.kind === 'renew' ? '갱신' : '구독';
        return `<li style="padding:0.45rem 0;border-bottom:1px solid var(--border, #333);">
          <strong>${kind}</strong> · ${amt}${p.currency || 'KRW'} · ${p.status || 'paid'}
          <div class="text-muted" style="font-size:0.78rem;">${when} · ${p.orderId || ''}</div>
        </li>`;
      }).join('')}</ul>`;
    } catch (err) {
      el.textContent = err.message || '결제 내역을 불러오지 못했습니다.';
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
      await renderHistory();
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
