(() => {
  const cfg = window.AdminConfig;
  const toastEl = document.getElementById('toast');
  let drawerUserId = null;

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
    return `<span class="badge ${cls}">${esc(text)}</span>`;
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function yn(v) {
    return v ? badge('Y', 'badge-ok') : badge('N', 'badge-free');
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

  function userFilters() {
    return {
      q: document.getElementById('userQuery').value.trim(),
      plan: document.getElementById('filterPlan').value,
      active: document.getElementById('filterActive').value,
      verified: document.getElementById('filterVerified').value,
      bot: document.getElementById('filterBot').value,
      limit: 300,
    };
  }

  async function loadOverview() {
    const d = await AdminApi.overview();
    const cards = [
      { label: '전체 사용자', value: d.usersTotal, hint: `활성 ${d.usersActive ?? '—'}` },
      { label: '미인증', value: d.usersUnverified, hint: `인증 ${d.usersVerified ?? '—'}` },
      { label: 'Pro', value: d.proSubscribers, hint: 'active / past_due' },
      { label: '봇 실행', value: d.botsRunning, hint: `한도 ${d.maxConcurrentBots ?? '—'}` },
      { label: '가입 7일', value: d.signups7d, hint: `30일 ${d.signups30d ?? '—'}` },
      { label: '바이낸스 키', value: d.usersWithBinanceKeys, hint: '저장된 계정' },
    ];
    document.getElementById('overviewCards').innerHTML = cards.map((c) => `
      <div class="card">
        <div class="label">${esc(c.label)}</div>
        <div class="value">${esc(c.value ?? '—')}</div>
        <div class="hint">${esc(c.hint)}</div>
      </div>
    `).join('');

    const flags = [
      ['메일', d.mailConfigured],
      ['Resend', d.resendConfigured],
      ['결제', d.paymentsConfigured],
      ['과금강제', d.billingEnforce],
      ['서버 OpenAI', d.openaiConfigured],
      ['Node', d.botDiagnostics?.nodeFound],
    ];
    document.getElementById('overviewFlags').innerHTML = flags.map(([k, v]) => `
      <div class="card">
        <div class="label">${esc(k)}</div>
        <div class="value" style="font-size:1.2rem">${v ? 'ON' : 'OFF'}</div>
      </div>
    `).join('');
  }

  function usageText(u) {
    const remBot = u.botHoursRemaining;
    const remGpt = u.gptRemaining;
    if (u.plan === 'pro') return `사용 봇 ${u.botHoursUsed ?? 0}h · AI ${u.gptCallsUsed ?? 0}`;
    return `남음 봇 ${remBot ?? '—'}h · AI ${remGpt ?? '—'}`;
  }

  async function loadUsers() {
    const data = await AdminApi.users(userFilters());
    const rows = data.users || [];
    const body = document.getElementById('usersBody');
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="9" style="color:var(--muted)">사용자 없음</td></tr>`;
      return;
    }
    body.innerHTML = rows.map((u) => {
      const plan = (u.plan || 'free').toLowerCase();
      return `
        <tr data-id="${esc(u.id)}" data-active="${u.isActive ? '1' : '0'}" data-plan="${esc(plan)}">
          <td>${esc(u.id)}</td>
          <td>
            <div>${esc(u.email)}</div>
            <div style="color:var(--muted);font-size:0.72rem">
              ${u.isAdmin ? '관리자 · ' : ''}${u.manualPro ? '수동Pro · ' : ''}${esc((u.createdAt || '').slice(0, 10))}
            </div>
          </td>
          <td>${badge(plan === 'pro' ? 'Pro' : 'Free', plan === 'pro' ? 'badge-pro' : 'badge-free')}</td>
          <td>${u.emailVerified ? badge('인증', 'badge-ok') : badge('미인증', 'badge-warn')}</td>
          <td>${u.isActive ? badge('ON', 'badge-ok') : badge('OFF', 'badge-bad')}</td>
          <td>${yn(u.hasBinanceKeys)} / ${yn(u.hasOpenAiKey)}</td>
          <td>${u.botRunning ? badge('실행', 'badge-ok') : badge('중지', 'badge-free')}</td>
          <td style="font-variant-numeric:tabular-nums;white-space:nowrap;font-size:0.8rem">${esc(usageText(u))}</td>
          <td>
            <div class="actions">
              <button class="btn btn-sm btn-primary" data-act="detail">상세</button>
              ${!u.emailVerified ? `<button class="btn btn-sm" data-act="verify">인증</button>` : ''}
              <button class="btn btn-sm" data-act="toggle-active">${u.isActive ? '비활성' : '활성'}</button>
              <button class="btn btn-sm" data-act="plan">${plan === 'pro' ? '→ Free' : '→ Pro'}</button>
              ${u.botRunning ? `<button class="btn btn-sm btn-danger" data-act="stop-bot">봇중지</button>` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function closeDrawer() {
    drawerUserId = null;
    document.getElementById('userDrawer').classList.remove('open');
    document.getElementById('drawerBackdrop').classList.remove('show');
    document.getElementById('userDrawer').setAttribute('aria-hidden', 'true');
  }

  function item(k, v) {
    return `<div class="detail-item"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
  }

  async function openDrawer(id) {
    drawerUserId = id;
    const drawer = document.getElementById('userDrawer');
    const body = document.getElementById('drawerBody');
    document.getElementById('drawerBackdrop').classList.add('show');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    body.innerHTML = '<p class="muted">불러오는 중…</p>';
    try {
      const data = await AdminApi.userDetail(id);
      const u = data.user || {};
      const usage = data.usage || {};
      const bot = data.bot || {};
      const strat = data.strategy || {};
      const logs = data.recentLogs || [];
      document.getElementById('drawerTitle').textContent = u.email || `User #${id}`;
      document.getElementById('drawerSub').textContent = `ID ${u.id} · 가입 ${(u.createdAt || '').slice(0, 19)}`;

      body.innerHTML = `
        <div class="detail-grid">
          ${item('플랜', esc(`${u.plan}${u.manualPro ? ' (수동)' : ''}`))}
          ${item('구독상태', esc(u.subscriptionStatus))}
          ${item('기간종료', esc(u.currentPeriodEnd || '—'))}
          ${item('결제키', u.hasBillingKey ? '있음' : '없음')}
          ${item('바이낸스', `${u.hasBinanceKeys ? (u.binanceTestnet ? '테스트넷' : '실거래') : '없음'}`)}
          ${item('OpenAI 키', u.hasOpenAiKey ? '있음' : '없음')}
          ${item('봇', u.botRunning ? '실행 중' : '중지')}
          ${item('쿼터주', esc(u.weekStart || '—'))}
        </div>

        <div>
          <div class="label" style="margin-bottom:8px;color:var(--muted);font-size:0.78rem">빠른 작업</div>
          <div class="drawer-actions">
            <button class="btn btn-sm" data-dact="verify">이메일 강제인증</button>
            <button class="btn btn-sm" data-dact="resend-verify">인증메일 재발송</button>
            <button class="btn btn-sm" data-dact="reset-mail">비번재설정 메일</button>
            <button class="btn btn-sm" data-dact="grant-7">Pro +7일</button>
            <button class="btn btn-sm" data-dact="grant-30">Pro +30일</button>
            <button class="btn btn-sm" data-dact="grant-365">Pro +365일</button>
            <button class="btn btn-sm" data-dact="to-free">Free로</button>
            <button class="btn btn-sm" data-dact="cancel-end">구독 기간종료 취소</button>
            <button class="btn btn-sm btn-danger" data-dact="cancel-now">구독 즉시 해지</button>
            <button class="btn btn-sm" data-dact="payments">결제내역</button>
            <button class="btn btn-sm btn-danger" data-dact="refund">결제 환불</button>
            <button class="btn btn-sm" data-dact="reset-quota">쿼터 리셋</button>
            <button class="btn btn-sm" data-dact="set-quota">쿼터 수동입력</button>
            <button class="btn btn-sm" data-dact="clear-gate">진입게이트 해제</button>
            <button class="btn btn-sm" data-dact="pause-entry">진입 15분 중지</button>
            <button class="btn btn-sm btn-danger" data-dact="stop-bot">봇 중지</button>
            <button class="btn btn-sm btn-danger" data-dact="del-binance">바이낸스키 삭제</button>
            <button class="btn btn-sm btn-danger" data-dact="del-openai">OpenAI키 삭제</button>
            <button class="btn btn-sm" data-dact="toggle-active">${u.isActive ? '계정 비활성' : '계정 활성'}</button>
          </div>
        </div>

        <div>
          <div class="muted" style="margin-bottom:6px">사용량</div>
          <pre class="pre-block">${esc(JSON.stringify(usage, null, 2))}</pre>
        </div>
        <div>
          <div class="muted" style="margin-bottom:6px">봇 상태</div>
          <pre class="pre-block">${esc(JSON.stringify({
            running: bot.running,
            pid: bot.pid,
            startedAt: bot.startedAt,
            liveTrading: bot.liveTrading,
            dryRun: bot.dryRun,
            testnet: bot.testnet,
            entryGate: bot.entryGate,
            persisted: bot.persisted,
          }, null, 2))}</pre>
        </div>
        <div>
          <div class="muted" style="margin-bottom:6px">전략 ${strat.exists ? '' : '(없음)'}</div>
          <pre class="pre-block">${esc(strat.exists ? JSON.stringify(strat.strategy || strat, null, 2) : '저장된 전략 없음')}</pre>
        </div>
        <div>
          <div class="muted" style="margin-bottom:6px">최근 봇 로그</div>
          <pre class="pre-block">${esc((logs || []).join('\n') || '(로그 없음)')}</pre>
        </div>
        <div>
          <div class="muted" style="margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">
            <span>사용자 활동 기록</span>
            <button type="button" class="btn btn-sm" data-dact="reload-activity">새로고침</button>
          </div>
          <div class="activity-list" id="drawerActivity">불러오는 중…</div>
        </div>
      `;
      loadDrawerActivity(id).catch((e) => {
        const el = document.getElementById('drawerActivity');
        if (el) el.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
      });
    } catch (err) {
      body.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    }
  }

  async function loadDrawerActivity(id) {
    const el = document.getElementById('drawerActivity');
    if (!el) return;
    const data = await AdminApi.userActivity(id, 80);
    const rows = data.activity || [];
    if (!rows.length) {
      el.innerHTML = '<p class="muted" style="padding:10px">아직 활동 기록이 없습니다.</p>';
      return;
    }
    el.innerHTML = `
      <table>
        <thead><tr><th>시각</th><th>작업</th><th>상세</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td class="mono">${esc((r.createdAt || '').replace('T', ' ').slice(0, 19))}</td>
              <td>${esc(r.action)}</td>
              <td class="mono">${esc(r.detail || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  async function drawerAction(act) {
    const id = drawerUserId;
    if (!id) return;
    try {
      let msg = '완료';
      if (act === 'verify') await AdminApi.verifyEmail(id);
      else if (act === 'resend-verify') ({ message: msg } = await AdminApi.resendVerify(id));
      else if (act === 'reset-mail') ({ message: msg } = await AdminApi.sendPasswordReset(id));
      else if (act === 'grant-7') ({ message: msg } = await AdminApi.grantPro(id, 7));
      else if (act === 'grant-30') ({ message: msg } = await AdminApi.grantPro(id, 30));
      else if (act === 'grant-365') ({ message: msg } = await AdminApi.grantPro(id, 365));
      else if (act === 'to-free') ({ message: msg } = await AdminApi.setPlan(id, 'free'));
      else if (act === 'cancel-end') ({ message: msg } = await AdminApi.cancelSubscription(id, false));
      else if (act === 'cancel-now') {
        if (!confirm('결제키까지 즉시 해지할까요?')) return;
        ({ message: msg } = await AdminApi.cancelSubscription(id, true));
      } else if (act === 'reload-activity') {
        await loadDrawerActivity(id);
        toast('활동 기록 갱신');
        return;
      } else if (act === 'payments') {
        const data = await AdminApi.listPayments(id);
        const rows = data.payments || [];
        alert(rows.length
          ? rows.map((p) => `${p.createdAt || ''} · ${p.kind} · ${p.amount}${p.currency || 'KRW'} · ${p.status} · key=${p.paymentKey || '-'}`).join('\n')
          : '결제 내역이 없습니다.');
        return;
      } else if (act === 'refund') {
        const paymentKey = prompt('환불할 Toss paymentKey를 입력하세요');
        if (!paymentKey) return;
        const reason = prompt('환불 사유', '관리자 환불') || '관리자 환불';
        const amt = prompt('부분 환불 금액(원). 전액이면 비우기', '');
        if (!confirm(`paymentKey=${paymentKey}\n사유=${reason}\n정말 환불할까요?`)) return;
        ({ message: msg } = await AdminApi.refundPayment(id, paymentKey, reason, amt));
      } else if (act === 'reset-quota') ({ message: msg } = await AdminApi.resetQuota(id));
      else if (act === 'set-quota') {
        const botH = prompt('봇 사용 시간(시간)을 입력하세요', '0');
        if (botH == null) return;
        const gpt = prompt('AI 사용 횟수를 입력하세요', '0');
        if (gpt == null) return;
        ({ message: msg } = await AdminApi.setQuota(id, {
          botHoursUsed: Number(botH),
          gptCallsUsed: Number(gpt),
        }));
      } else if (act === 'clear-gate') ({ message: msg } = await AdminApi.clearEntryGate(id));
      else if (act === 'pause-entry') ({ message: msg } = await AdminApi.pauseEntry(id, 15));
      else if (act === 'stop-bot') ({ message: msg } = await AdminApi.stopBot(id));
      else if (act === 'del-binance') {
        if (!confirm('바이낸스 API 키를 삭제할까요?')) return;
        ({ message: msg } = await AdminApi.deleteBinanceKeys(id));
      } else if (act === 'del-openai') {
        if (!confirm('OpenAI 키를 삭제할까요?')) return;
        ({ message: msg } = await AdminApi.deleteOpenAiKey(id));
      } else if (act === 'toggle-active') {
        const detail = await AdminApi.userDetail(id);
        await AdminApi.setActive(id, !detail.user?.isActive);
      }
      toast(msg || '완료');
      await openDrawer(id);
      await loadUsers().catch(() => {});
      await loadOverview().catch(() => {});
    } catch (err) {
      toast(err.message || '실패', 'err');
    }
  }

  async function onUserAction(btn) {
    const tr = btn.closest('tr');
    const id = tr?.dataset?.id;
    if (!id) return;
    const act = btn.dataset.act;
    btn.disabled = true;
    try {
      if (act === 'detail') {
        await openDrawer(id);
        return;
      }
      if (act === 'verify') await AdminApi.verifyEmail(id);
      else if (act === 'toggle-active') await AdminApi.setActive(id, tr.dataset.active !== '1');
      else if (act === 'plan') {
        const plan = tr.dataset.plan || 'free';
        if (plan === 'pro') await AdminApi.setPlan(id, 'free');
        else {
          const days = prompt('Pro 부여 일수', '30');
          if (days == null) return;
          await AdminApi.setPlan(id, 'pro', Number(days) || 30);
        }
      } else if (act === 'stop-bot') await AdminApi.stopBot(id);
      toast('완료');
      await loadUsers();
      await loadOverview().catch(() => {});
    } catch (err) {
      toast(err.message || '실패', 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function loadBots() {
    const data = await AdminApi.bots();
    const diag = data.diagnostics || {};
    document.getElementById('botDiagCards').innerHTML = [
      { label: 'Node', value: diag.nodeFound ? (diag.nodeVersion || 'OK') : '없음', hint: diag.nodePath || '—' },
      { label: 'bot.js', value: diag.botScriptExists ? 'OK' : 'MISSING', hint: '스크립트' },
      { label: '실행 중', value: diag.runningBots ?? data.count, hint: `한도 ${diag.maxConcurrentBots ?? '—'}` },
    ].map((c) => `
      <div class="card">
        <div class="label">${esc(c.label)}</div>
        <div class="value" style="font-size:1.25rem">${esc(c.value)}</div>
        <div class="hint">${esc(c.hint)}</div>
      </div>
    `).join('');

    const rows = data.bots || [];
    const body = document.getElementById('botsBody');
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7" style="color:var(--muted)">실행/유지 중인 봇 없음</td></tr>`;
      return;
    }
    body.innerHTML = rows.map((b) => {
      const uid = b.userId ?? b.botKey;
      const gate = b.entryGate?.active ? 'paused' : '—';
      return `
        <tr data-id="${esc(uid)}">
          <td>
            <div>${esc(b.email || (b.userId == null ? 'legacy/0' : `#${b.userId}`))}</div>
            <div class="muted">id ${esc(uid)}</div>
          </td>
          <td>${b.running ? badge('실행', 'badge-ok') : badge(b.persisted ? '유지' : '중지', 'badge-warn')}</td>
          <td class="mono">${esc(b.pid || '—')}</td>
          <td>${b.liveTrading ? badge('실거래', 'badge-bad') : badge('DRY', 'badge-free')} ${b.testnet ? badge('testnet', 'badge-warn') : ''}</td>
          <td class="mono">${esc((b.startedAt || '').toString().slice(0, 19) || '—')}</td>
          <td>${esc(gate)}</td>
          <td>
            <div class="actions">
              <button class="btn btn-sm" data-bact="detail">상세</button>
              <button class="btn btn-sm btn-danger" data-bact="stop">중지</button>
              <button class="btn btn-sm" data-bact="clear-gate">게이트해제</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function loadAudit() {
    const data = await AdminApi.audit(120);
    const rows = data.actions || [];
    const body = document.getElementById('auditBody');
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="5" style="color:var(--muted)">아직 기록된 작업 없음</td></tr>`;
      return;
    }
    body.innerHTML = rows.map((a) => `
      <tr>
        <td class="mono">${esc((a.at || '').replace('T', ' ').slice(0, 19))}</td>
        <td>${esc(a.adminEmail)}</td>
        <td>${esc(a.action)}</td>
        <td>${esc(a.targetUserId ?? '—')}</td>
        <td class="mono">${esc(a.detail || '')}</td>
      </tr>
    `).join('');
  }

  async function loadActivity() {
    const userId = document.getElementById('activityUserId')?.value.trim() || '';
    const action = document.getElementById('activityAction')?.value.trim() || '';
    const data = await AdminApi.activity({ limit: 150, userId, action });
    const rows = data.activity || [];
    document.getElementById('activityBody').innerHTML = rows.length
      ? rows.map((r) => `
        <tr>
          <td class="mono">${esc((r.createdAt || '').replace('T', ' ').slice(0, 19))}</td>
          <td>${esc(r.email || r.userId || '—')} <span class="muted">#${esc(r.userId)}</span></td>
          <td>${esc(r.action)}</td>
          <td class="mono">${esc(r.detail || '')}</td>
          <td class="mono">${esc(r.ip || '—')}</td>
        </tr>
      `).join('')
      : '<tr><td colspan="5" class="muted">활동 기록이 없습니다. 로그인·봇 시작 후 쌓입니다.</td></tr>';
  }

  async function loadSettings() {
    const data = await AdminApi.settings();
    const editable = data.editable || [];
    document.getElementById('settingsEditable').innerHTML = editable.map((f) => {
      const key = f.key;
      const val = f.value;
      if (f.type === 'bool') {
        return `
          <div class="setting-field">
            <label>${esc(f.label)}</label>
            <div class="key">${esc(key)}</div>
            <label class="bool-row">
              <input type="checkbox" data-setkey="${esc(key)}" data-settype="bool" ${val ? 'checked' : ''} />
              <span>${val ? 'ON' : 'OFF'}</span>
            </label>
          </div>`;
      }
      const inputType = f.type === 'str' ? 'text' : 'number';
      const step = f.type === 'float' ? 'any' : (f.type === 'int' ? '1' : undefined);
      return `
        <div class="setting-field">
          <label>${esc(f.label)}</label>
          <div class="key">${esc(key)}</div>
          <input type="${inputType}" data-setkey="${esc(key)}" data-settype="${esc(f.type)}"
            value="${esc(val ?? '')}"
            ${f.min != null ? `min="${esc(f.min)}"` : ''}
            ${f.max != null ? `max="${esc(f.max)}"` : ''}
            ${step ? `step="${step}"` : ''} />
        </div>`;
    }).join('');

    document.querySelectorAll('#settingsEditable input[data-settype="bool"]').forEach((el) => {
      el.addEventListener('change', () => {
        const span = el.parentElement?.querySelector('span');
        if (span) span.textContent = el.checked ? 'ON' : 'OFF';
      });
    });

    const flat = {
      note: data.note || '',
      ...(data.flags || {}),
      ...(data.secrets || {}),
      ...(data.business || {}),
      ...(data.botDiagnostics || {}),
    };
    document.getElementById('settingsGrid').innerHTML = Object.entries(flat).map(([k, v]) => `
      <div class="setting-row">
        <div class="k">${esc(k)}</div>
        <div class="v">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</div>
      </div>
    `).join('');
  }

  async function saveSettings() {
    const settings = {};
    document.querySelectorAll('#settingsEditable [data-setkey]').forEach((el) => {
      const key = el.dataset.setkey;
      const typ = el.dataset.settype;
      if (typ === 'bool') settings[key] = !!el.checked;
      else if (typ === 'int') settings[key] = Number(el.value);
      else if (typ === 'float') settings[key] = Number(el.value);
      else settings[key] = el.value;
    });
    if (!confirm('선택한 설정을 서버 .env에 저장할까요?')) return;
    const res = await AdminApi.updateSettings(settings);
    toast(res.message || '저장됨');
    await loadSettings();
  }

  async function confirmStopAll() {
    if (!confirm('실행 중인 모든 봇을 중지할까요?')) return;
    try {
      const r = await AdminApi.stopAllBots();
      toast(r.message || '전체 중지 요청 완료');
      await loadBots().catch(() => {});
      await loadOverview().catch(() => {});
    } catch (err) {
      toast(err.message || '실패', 'err');
    }
  }

  async function init() {
    document.getElementById('tradingLink').href = cfg.tradingUrl;
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('drawerClose').addEventListener('click', closeDrawer);
    document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);

    const me = await requireAdmin();
    if (!me) return;

    document.querySelectorAll('.nav button').forEach((b) => {
      b.addEventListener('click', () => {
        const name = b.dataset.panel;
        switchPanel(name);
        if (name === 'users') loadUsers().catch((e) => toast(e.message, 'err'));
        if (name === 'bots') loadBots().catch((e) => toast(e.message, 'err'));
        if (name === 'activity') loadActivity().catch((e) => toast(e.message, 'err'));
        if (name === 'audit') loadAudit().catch((e) => toast(e.message, 'err'));
        if (name === 'settings') loadSettings().catch((e) => toast(e.message, 'err'));
        if (name === 'overview') loadOverview().catch((e) => toast(e.message, 'err'));
      });
    });

    document.getElementById('refreshOverview').addEventListener('click', () => {
      loadOverview().then(() => toast('갱신됨')).catch((e) => toast(e.message, 'err'));
    });
    document.getElementById('stopAllBotsOverview').addEventListener('click', confirmStopAll);
    document.getElementById('stopAllBots').addEventListener('click', confirmStopAll);
    document.getElementById('refreshBots').addEventListener('click', () => {
      loadBots().then(() => toast('갱신됨')).catch((e) => toast(e.message, 'err'));
    });
    document.getElementById('refreshAudit').addEventListener('click', () => {
      loadAudit().then(() => toast('갱신됨')).catch((e) => toast(e.message, 'err'));
    });
    document.getElementById('refreshActivity')?.addEventListener('click', () => {
      loadActivity().then(() => toast('갱신됨')).catch((e) => toast(e.message, 'err'));
    });
    document.getElementById('refreshSettings').addEventListener('click', () => {
      loadSettings().then(() => toast('갱신됨')).catch((e) => toast(e.message, 'err'));
    });
    document.getElementById('saveSettings')?.addEventListener('click', () => {
      saveSettings().catch((e) => toast(e.message || '저장 실패', 'err'));
    });
    document.getElementById('searchUsers').addEventListener('click', () => {
      loadUsers().catch((e) => toast(e.message, 'err'));
    });
    document.getElementById('reloadUsers').addEventListener('click', () => {
      document.getElementById('userQuery').value = '';
      document.getElementById('filterPlan').value = 'all';
      document.getElementById('filterActive').value = 'all';
      document.getElementById('filterVerified').value = 'all';
      document.getElementById('filterBot').value = 'all';
      loadUsers().catch((e) => toast(e.message, 'err'));
    });
    document.getElementById('userQuery').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('searchUsers').click();
    });
    document.getElementById('usersBody').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (btn) onUserAction(btn);
    });
    document.getElementById('botsBody').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-bact]');
      if (!btn) return;
      const tr = btn.closest('tr');
      const id = tr?.dataset?.id;
      if (!id) return;
      try {
        if (btn.dataset.bact === 'detail') await openDrawer(id);
        else if (btn.dataset.bact === 'stop') {
          await AdminApi.stopBot(id);
          toast('봇 중지');
          await loadBots();
        } else if (btn.dataset.bact === 'clear-gate') {
          await AdminApi.clearEntryGate(id);
          toast('게이트 해제');
          await loadBots();
        }
      } catch (err) {
        toast(err.message || '실패', 'err');
      }
    });
    document.getElementById('drawerBody').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-dact]');
      if (btn) drawerAction(btn.dataset.dact);
    });

    try {
      await loadOverview();
    } catch (err) {
      toast(err.message || '대시보드 로드 실패', 'err');
    }
  }

  init();
})();
