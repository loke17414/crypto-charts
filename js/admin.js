/* Orbinex developer / admin panel */
const AppAdmin = (() => {
  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(text) {
    const el = $('adminStatus');
    if (el) el.textContent = text;
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderOverview(data) {
    const box = $('adminOverview');
    if (!box || !data) return;
    const cards = [
      ['가입', data.usersTotal],
      ['인증 완료', data.usersVerified],
      ['미인증', data.usersUnverified],
      ['활성 계정', data.usersActive],
      ['Pro', data.proSubscribers],
      [`봇 실행 (${data.botsRunning}/${data.maxConcurrentBots})`, data.botsRunning],
    ];
    const flags = [
      data.resendConfigured ? 'Resend OK' : 'Resend 없음',
      data.mailConfigured ? '메일 OK' : '메일 없음',
      data.paymentsConfigured ? 'Toss OK' : 'Toss 없음',
      data.openaiConfigured ? 'OpenAI OK' : 'OpenAI 없음',
      data.billingEnforce ? '쿼터 강제 ON' : '쿼터 강제 OFF',
    ];
    box.innerHTML = `
      <div class="admin-stats__grid">
        ${cards.map(([k, v]) => `
          <div class="admin-stat">
            <span class="admin-stat__label">${esc(k)}</span>
            <strong class="admin-stat__value">${esc(v)}</strong>
          </div>`).join('')}
      </div>
      <p class="admin-flags">${flags.map((f) => `<span>${esc(f)}</span>`).join('')}</p>
    `;
  }

  function renderSettings(data) {
    const el = $('adminSettings');
    if (!el || !data) return;
    el.textContent = JSON.stringify(
      {
        note: data.note,
        limits: data.limits,
        flags: data.flags,
      },
      null,
      2,
    );
  }

  async function runAction(userId, action, body) {
    try {
      let result;
      if (action === 'verify') result = await FuturesApiClient.adminVerifyEmail(userId);
      else if (action === 'activate') result = await FuturesApiClient.adminSetActive(userId, true);
      else if (action === 'deactivate') result = await FuturesApiClient.adminSetActive(userId, false);
      else if (action === 'pro') result = await FuturesApiClient.adminSetPlan(userId, 'pro');
      else if (action === 'free') result = await FuturesApiClient.adminSetPlan(userId, 'free');
      else if (action === 'resetQuota') result = await FuturesApiClient.adminResetQuota(userId);
      else if (action === 'stopBot') result = await FuturesApiClient.adminStopBot(userId);
      else return;
      if (result?.message) setStatus(result.message);
      await loadUsers();
      await loadOverview();
    } catch (err) {
      alert(err.message || '작업 실패');
    }
  }

  function renderUsers(data) {
    const body = $('adminUsersBody');
    const note = $('adminUsersNote');
    if (!body) return;
    const users = data?.users || [];
    if (note) note.textContent = `${users.length}명 표시`;
    if (!users.length) {
      body.innerHTML = '<tr><td colspan="7">사용자 없음</td></tr>';
      return;
    }
    body.innerHTML = users.map((u) => {
      const status = [
        u.isActive ? '활성' : '비활성',
        u.emailVerified ? '인증' : '미인증',
        u.isAdmin ? '관리자' : '',
      ].filter(Boolean).join(' · ');
      const plan = u.plan === 'pro'
        ? (u.manualPro ? 'Pro (수동)' : 'Pro')
        : 'Free';
      const usage = `봇 ${u.botHoursUsed}h · GPT ${u.gptCallsUsed}`;
      const bot = u.botRunning ? '실행 중' : '정지';
      return `
        <tr data-user-id="${u.id}">
          <td>${u.id}</td>
          <td class="admin-email">${esc(u.email)}</td>
          <td>${esc(status)}</td>
          <td>${esc(plan)}</td>
          <td>${esc(usage)}</td>
          <td>${esc(bot)}</td>
          <td class="admin-actions">
            <button type="button" data-act="verify" ${u.emailVerified ? 'disabled' : ''}>인증</button>
            <button type="button" data-act="${u.isActive ? 'deactivate' : 'activate'}">${u.isActive ? '비활성' : '활성'}</button>
            <button type="button" data-act="${u.plan === 'pro' ? 'free' : 'pro'}">${u.plan === 'pro' ? 'Free' : 'Pro'}</button>
            <button type="button" data-act="resetQuota">쿼터리셋</button>
            <button type="button" data-act="stopBot" ${u.botRunning ? '' : 'disabled'}>봇정지</button>
          </td>
        </tr>`;
    }).join('');
  }

  async function loadOverview() {
    const data = await FuturesApiClient.adminOverview();
    renderOverview(data);
  }

  async function loadSettings() {
    const data = await FuturesApiClient.adminSettings();
    renderSettings(data);
  }

  async function loadUsers() {
    const q = $('adminUserQuery')?.value?.trim() || '';
    const data = await FuturesApiClient.adminUsers({ q, limit: 200 });
    renderUsers(data);
  }

  async function boot() {
    const denied = $('adminDenied');
    const panel = $('adminPanel');
    try {
      if (typeof AppAuth !== 'undefined') {
        await AppAuth.init?.();
      }
      if (!AppAuth?.isLoggedIn?.()) {
        setStatus('로그인이 필요합니다.');
        denied?.classList.remove('hidden');
        panel?.classList.add('hidden');
        return;
      }
      const me = await FuturesApiClient.adminMe();
      if (!me?.admin) {
        setStatus('관리자 권한이 없습니다. ADMIN_EMAILS를 확인하세요.');
        denied?.classList.remove('hidden');
        panel?.classList.add('hidden');
        return;
      }
      denied?.classList.add('hidden');
      panel?.classList.remove('hidden');
      if ($('adminEmail')) $('adminEmail').textContent = me.email || '—';
      setStatus('관리자 모드');
      await Promise.all([loadOverview(), loadSettings(), loadUsers()]);
    } catch (err) {
      setStatus(err.message || '접근 불가');
      denied?.classList.remove('hidden');
      panel?.classList.add('hidden');
    }
  }

  function bind() {
    $('adminUserSearchBtn')?.addEventListener('click', () => loadUsers().catch((e) => alert(e.message)));
    $('adminUserRefreshBtn')?.addEventListener('click', () => {
      Promise.all([loadOverview(), loadUsers()]).catch((e) => alert(e.message));
    });
    $('adminUserQuery')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadUsers().catch((err) => alert(err.message));
      }
    });
    $('adminUsersBody')?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || btn.disabled) return;
      const tr = btn.closest('tr[data-user-id]');
      if (!tr) return;
      const id = Number(tr.dataset.userId);
      const act = btn.getAttribute('data-act');
      if (act === 'deactivate' && !window.confirm(`사용자 #${id} 를 비활성화할까요?`)) return;
      if (act === 'pro' && !window.confirm(`사용자 #${id} 에 수동 Pro를 부여할까요?`)) return;
      runAction(id, act);
    });
  }

  return { boot, bind };
})();

document.addEventListener('DOMContentLoaded', () => {
  AppAdmin.bind();
  AppAdmin.boot();
});
