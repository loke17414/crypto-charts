/* Admin console — same-origin /api (admin.* nginx or main host /admin-site/) */
window.AdminConfig = Object.freeze({
  // Empty = same host. Cross-origin example: 'https://orbinex.net'
  apiBase: '',
  appName: 'Orbinex Console',
  tradingUrl: (function () {
    var h = location.hostname || '';
    if (h === 'admin.orbinex.net') return 'https://orbinex.net/trading.html';
    if (h.endsWith('orbinex.net')) return '/trading.html';
    return '../trading.html';
  })(),
  tokenKey: 'orbinex-admin-token',
  userKey: 'orbinex-admin-user',
});
