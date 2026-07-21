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
    const res = await fetch(`${base()}${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.detail;
      const msg = typeof detail === 'string'
        ? detail
        : (data?.message || `요청 실패 (${res.status})`);
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    login: (email, password) => request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
    me: () => request('/api/auth/me'),
    adminMe: () => request('/api/admin/me'),
    overview: () => request('/api/admin/overview'),
    settings: () => request('/api/admin/settings'),
    users: ({ q = '', limit = 200 } = {}) => {
      const p = new URLSearchParams({ limit: String(limit) });
      if (q) p.set('q', q);
      return request(`/api/admin/users?${p}`);
    },
    verifyEmail: (id) => request(`/api/admin/users/${id}/verify-email`, { method: 'POST', body: '{}' }),
    setActive: (id, active) => request(`/api/admin/users/${id}/set-active`, {
      method: 'POST',
      body: JSON.stringify({ active: !!active }),
    }),
    setPlan: (id, plan) => request(`/api/admin/users/${id}/set-plan`, {
      method: 'POST',
      body: JSON.stringify({ plan }),
    }),
    resetQuota: (id) => request(`/api/admin/users/${id}/reset-quota`, { method: 'POST', body: '{}' }),
    stopBot: (id) => request(`/api/admin/users/${id}/stop-bot`, { method: 'POST', body: '{}' }),
  };
})();

window.AdminApi = AdminApi;
