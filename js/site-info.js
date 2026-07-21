/* Fill support email / business identity from /api/public/site */
(async () => {
  try {
    const res = await fetch('/api/public/site', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const email = data.supportEmail || data.business?.supportEmail;
    if (email) {
      document.querySelectorAll('[data-support-email]').forEach((el) => {
        if (el.tagName === 'A') {
          el.href = `mailto:${email}`;
          if (!el.dataset.keepLabel) el.textContent = email;
        } else {
          el.textContent = email;
        }
      });
    }
    const b = data.business || {};
    const block = document.getElementById('businessBlock');
    if (block && (b.name || b.registrationNumber || b.representative || b.address)) {
      const lines = [];
      if (b.name) lines.push(`상호: ${b.name}`);
      if (b.representative) lines.push(`대표: ${b.representative}`);
      if (b.registrationNumber) lines.push(`사업자등록번호: ${b.registrationNumber}`);
      if (b.address) lines.push(`주소: ${b.address}`);
      lines.push(`고객센터: ${email || 'support@orbinex.net'}`);
      block.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
    }
  } catch {
    /* ignore — static fallback remains */
  }
})();
