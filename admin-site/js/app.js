(() => {
  const cfg = window.AdminConfig;
  const toastEl = document.getElementById('toast');

  function toast(msg, type = 'ok') {
    toastEl.textContent = msg;
    toastEl.className = `toast show ${type}`;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 3200);
  }

  function logout() {
    localStorage.removeItem(cfg.tokenKey);
    localStorage.removeItem(cfg.userKey);
    location.href = './login.html';
  }

  function badge(text, cls) {
    return `<span class="badge ${cls}">${text}</span>`;
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function requireAdmin() {
    const token = localStorage.getItem(cfg.tokenKey);
    if (!token) {
      location.href = './login.html';
      return null;
    }
    try {
      const me = await AdminApi.adminMe();
      document.getElementById('adminEmail').textContent = me.email || 'admin';
      return me;
    } catch {
      logout();
      return null;
    }
  }

  function switchPanel(name) {
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav button').forEach((b) => b.classList.remove('active'));
    document.getElementById(`panel-${name}`)?.classList.add('active');
    document.querySelector(`.nav button[data-panel="${name}"]`)?.classList.add('active');
  }

  async function loadOverview() {
    const d = await AdminApi.overview();
    const cards = [
      { label: '전체 사용자', value: d.usersTotal, hint: `활성 ${d.usersActive ?? '—'}` },
      { label: '미인증', value: d.usersUnverified, hint: `인증 ${d.usersVerified ?? '—'}` },
      { label: 'Pro', value: d.proSubscribers, hint: 'active / past_due' },
      {
        label: '봇 실행',
        value: d.botsRunning,
        hint: `한도 ${d.maxConcurrentBots ?? '—'}`,
      },
    ];
    document.getElementById('overviewCards').innerHTML = cards.map((c) => `
      <div class="card">
        <div class="label">${esc(c.label)}</div>
        <div class="value">${esc(c.value ?? '—')}</div>
        <div class="hint">${esc(c.hint)}</div>
      </div>
    `).join('');
  }

  function usageText(u) {
    return `봇 ${u.botHoursUsed ?? 0}h · GPT ${u.gptCallsUsed ?? 0}`;
  }

  async function loadUsers(q = '') {
    const data = await AdminApi.users({ q, limit: 300 });
    const rows = data.users || [];
    const body = document.getElementById('usersBody');
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="8" style="color:var(--muted)">사용자 없음</td></tr>`;
      return;
    }
    body.innerHTML = rows.map((u) => {
      const plan = (u.plan || 'free').toLowerCase();
      const verified = !!u.emailVerified;
      const active = !!u.isActive;
      const botOn = !!u.botRunning;
      return `
        <tr data-id="${esc(u.id)}" data-active="${active ? '1' : '0'}" data-plan="${esc(plan)}">
          <td>${esc(u.id)}</td>
          <td>
            <div>${esc(u.email)}</div>
            <div style="color:var(--muted);font-size:0.75rem">${u.isAdmin ? '관리자' : ''}</div>
          </td>
          <td>${badge(plan === 'pro' ? 'Pro' : 'Free', plan === 'pro' ? 'badge-pro' : 'badge-free')}</td>
          <td>${verified ? badge('인증', 'badge-ok') : badge('미인증', 'badge-warn')}</td>
          <td>${active ? badge('ON', 'badge-ok') : badge('OFF', 'badge-bad')}</td>
          <td>${botOn ? badge('실행', 'badge-ok') : badge('중지', 'badge-free')}</td>
          <td style="font-variant-numeric:tabular-nums;white-space:nowrap">${esc(usageText(u))}</td>
          <td>
            <div class="actions">
              ${!verified ? `<button class="btn btn-sm" data-act="verify">인증</button>` : ''}
              <button class="btn btn-sm" data-act="toggle-active">${active ? '비활성' : '활성'}</button>
              <button class="btn btn-sm" data-act="plan">${plan === 'pro' ? '→ Free' : '→ Pro'}</button>
              <button class="btn btn-sm" data-act="reset-quota">쿼터</button>
              ${botOn ? `<button class="btn btn-sm btn-danger" data-act="stop-bot">봇중지</button>` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function loadSettings() {
    const data = await AdminApi.settings();
    const flat = {
      ...(data.limits || {}),
      ...(data.flags || {}),
      note: data.note || '',
    };
    document.getElementById('settingsGrid').innerHTML = Object.entries(flat).map(([k, v]) => `
      <div class="setting-row">
        <div class="k">${esc(k)}</div>
        <div class="v">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</div>
      </div>
    `).join('') || '<div class="setting-row"><div class="k">설정 없음</div></div>';
  }

  async function onUserAction(btn) {
    const tr = btn.closest('tr');
    const id = tr?.dataset?.id;
    if (!id) return;
    const act = btn.dataset.act;
    btn.disabled = true;
    try {
      if (act === 'verify') await AdminApi.verifyEmail(id);
      else if (act === 'toggle-active') {
        const isOn = tr.dataset.active === '1';
        await AdminApi.setActive(id, !isOn);
      } else if (act === 'plan') {
        const plan = tr.dataset.plan || 'free';
        await AdminApi.setPlan(id, plan === 'pro' ? 'free' : 'pro');
      } else if (act === 'reset-quota') await AdminApi.resetQuota(id);
      else if (act === 'stop-bot') await AdminApi.stopBot(id);
      toast('완료');
      await loadUsers(document.getElementById('userQuery').value.trim());
      await loadOverview().catch(() => {});
    } catch (err) {
      toast(err.message || '실패', 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function init() {
    document.getElementById('tradingLink').href = cfg.tradingUrl;
    document.getElementById('logoutBtn').addEventListener('click', logout);

    const me = await requireAdmin();
    if (!me) return;

    document.querySelectorAll('.nav button').forEach((b) => {
      b.addEventListener('click', () => {
        const name = b.dataset.panel;
        switchPanel(name);
        if (name === 'users') loadUsers().catch((e) => toast(e.message, 'err'));
        if (name === 'settings') loadSettings().catch((e) => toast(e.message, 'err'));
        if (name === 'overview') loadOverview().catch((e) => toast(e.message, 'err'));
      });
    });

    document.getElementById('refreshOverview').addEventListener('click', () => {
      loadOverview().then(() => toast('갱신됨')).catch((e) => toast(e.message, 'err'));
    });
    document.getElementById('refreshSettings').addEventListener('click', () => {
      loadSettings().then(() => toast('갱신됨')).catch((e) => toast(e.message, 'err'));
    });
    document.getElementById('searchUsers').addEventListener('click', () => {
      loadUsers(document.getElementById('userQuery').value.trim()).catch((e) => toast(e.message, 'err'));
    });
    document.getElementById('reloadUsers').addEventListener('click', () => {
      document.getElementById('userQuery').value = '';
      loadUsers().catch((e) => toast(e.message, 'err'));
    });
    document.getElementById('userQuery').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('searchUsers').click();
    });
    document.getElementById('usersBody').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (btn) onUserAction(btn);
    });

    try {
      await loadOverview();
    } catch (err) {
      toast(err.message || '대시보드 로드 실패', 'err');
    }
  }

  init();
})();
