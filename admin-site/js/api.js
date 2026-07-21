const AdminApi = (() => {
  function base() {
    return (window.AdminConfig && window.AdminConfig.apiBase) || '';
  }

  function token() {
    return localStorage.getItem(window.AdminConfig.tokenKey) || '';
  }

  async function request(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    const t = token();
    if (t) headers.Authorization = `Bearer ${t}`;
    let res;
    try {
      res = await fetch(`${base()}${path}`, { ...options, headers, cache: 'no-store' });
    } catch (networkErr) {
      const err = new Error(networkErr?.message || 'Failed to fetch');
      err.status = 0;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.detail;
      const msg = typeof detail === 'string'
        ? detail
        : (Array.isArray(detail) ? (detail[0]?.msg || JSON.stringify(detail)) : null)
          || data?.message
          || `요청 실패 (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function post(path, body = {}) {
    return request(path, { method: 'POST', body: JSON.stringify(body) });
  }

  return {
    login: (email, password) => post('/api/auth/login', { email, password }),
    me: () => request('/api/auth/me'),
    adminMe: () => request('/api/admin/me'),
    overview: () => request('/api/admin/overview'),
    settings: () => request('/api/admin/settings'),
    audit: (limit = 80) => request(`/api/admin/audit?limit=${limit}`),
    users: ({ q = '', plan = 'all', active = 'all', verified = 'all', bot = 'all', limit = 200 } = {}) => {
      const p = new URLSearchParams({
        limit: String(limit),
        plan,
        active,
        verified,
        bot,
      });
      if (q) p.set('q', q);
      return request(`/api/admin/users?${p}`);
    },
    userDetail: (id) => request(`/api/admin/users/${id}`),
    verifyEmail: (id) => post(`/api/admin/users/${id}/verify-email`),
    resendVerify: (id) => post(`/api/admin/users/${id}/resend-verify`),
    sendPasswordReset: (id) => post(`/api/admin/users/${id}/send-password-reset`),
    setActive: (id, active) => post(`/api/admin/users/${id}/set-active`, { active: !!active }),
    setPlan: (id, plan, days) => post(`/api/admin/users/${id}/set-plan`, {
      plan,
      ...(days ? { days: Number(days) } : {}),
    }),
    grantPro: (id, days) => post(`/api/admin/users/${id}/grant-pro`, { days: Number(days) || 30 }),
    cancelSubscription: (id, immediate = false) => post(`/api/admin/users/${id}/cancel-subscription`, { immediate: !!immediate }),
    resetQuota: (id) => post(`/api/admin/users/${id}/reset-quota`),
    setQuota: (id, body) => post(`/api/admin/users/${id}/set-quota`, body),
    stopBot: (id) => post(`/api/admin/users/${id}/stop-bot`),
    clearEntryGate: (id) => post(`/api/admin/users/${id}/clear-entry-gate`),
    pauseEntry: (id, minutes = 15) => post(`/api/admin/users/${id}/pause-entry`, { minutes }),
    deleteBinanceKeys: (id) => post(`/api/admin/users/${id}/delete-binance-keys`),
    deleteOpenAiKey: (id) => post(`/api/admin/users/${id}/delete-openai-key`),
    bots: () => request('/api/admin/bots'),
    stopAllBots: () => post('/api/admin/bots/stop-all'),
  };
})();

window.AdminApi = AdminApi;
