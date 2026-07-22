/* Fill support email / business identity from /api/public/site */
(function () {
  const FALLBACK = {
    name: '오비넥스',
    representative: '이동건',
    registrationNumber: '203-25-55373',
    address: '경기 군포시 산본천로33 701동703호',
    phone: '010-3142-1916',
    supportEmail: 'support@orbinex.net',
  };

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function telHref(phone) {
    return `tel:${String(phone || '').replace(/[^0-9+]/g, '')}`;
  }

  function footerHtml(b) {
    const phone = b.phone || FALLBACK.phone;
    return (
      `상호명 ${esc(b.name)} · 사업자등록번호 ${esc(b.registrationNumber)} · 대표자 ${esc(b.representative)}` +
      `<br>사업장주소 ${esc(b.address)} · 연락처 <a href="${telHref(phone)}">${esc(phone)}</a>`
    );
  }

  function legalHtml(b, email) {
    const phone = b.phone || FALLBACK.phone;
    const lines = [
      `상호명: ${esc(b.name)}`,
      `대표자: ${esc(b.representative)}`,
      `사업자등록번호: ${esc(b.registrationNumber)}`,
      `사업장주소: ${esc(b.address)}`,
      `연락처: <a href="${telHref(phone)}">${esc(phone)}</a>`,
      `고객센터: <a href="mailto:${esc(email)}">${esc(email)}</a>`,
    ];
    return lines.map((l) => `<div>${l}</div>`).join('');
  }

  function apply(b, email) {
    const biz = {
      name: b.name || FALLBACK.name,
      representative: b.representative || FALLBACK.representative,
      registrationNumber: b.registrationNumber || FALLBACK.registrationNumber,
      address: b.address || FALLBACK.address,
      phone: b.phone || FALLBACK.phone,
    };
    document.querySelectorAll('[data-business-footer]').forEach((el) => {
      el.innerHTML = footerHtml(biz);
    });
    const block = document.getElementById('businessBlock');
    if (block) {
      if (block.hasAttribute('data-business-footer')) {
        block.innerHTML = footerHtml(biz);
      } else {
        block.innerHTML = legalHtml(biz, email || FALLBACK.supportEmail);
      }
    }
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
  }

  // Static fallback immediately (works even if API is down)
  apply(FALLBACK, FALLBACK.supportEmail);

  fetch('/api/public/site', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data) return;
      const email = data.supportEmail || data.business?.supportEmail || FALLBACK.supportEmail;
      apply(data.business || {}, email);
    })
    .catch(() => { /* keep fallback */ });
})();
