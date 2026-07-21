/* Shared modal dialogs — replaces page banners / native alert·confirm for notices */
const UiModal = (() => {
  let root = null;
  let resolveFn = null;

  function ensure() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'uiModalRoot';
    root.className = 'ui-modal hidden';
    root.innerHTML = `
      <div class="ui-modal__backdrop" data-ui-modal-dismiss></div>
      <div class="ui-modal__panel" role="dialog" aria-modal="true" aria-labelledby="uiModalTitle">
        <h2 class="ui-modal__title" id="uiModalTitle"></h2>
        <p class="ui-modal__body" id="uiModalBody"></p>
        <div class="ui-modal__actions" id="uiModalActions"></div>
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-ui-modal-dismiss]')) close(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root && !root.classList.contains('hidden')) {
        close(false);
      }
    });
    return root;
  }

  function close(result) {
    if (!root) return;
    root.classList.add('hidden');
    document.body.classList.remove('ui-modal-open');
    const fn = resolveFn;
    resolveFn = null;
    if (fn) fn(result);
  }

  function open({ title = '안내', message = '', confirmText = '확인', cancelText = null, danger = false } = {}) {
    ensure();
    const titleEl = root.querySelector('#uiModalTitle');
    const bodyEl = root.querySelector('#uiModalBody');
    const actions = root.querySelector('#uiModalActions');
    titleEl.textContent = title;
    bodyEl.textContent = message;
    actions.innerHTML = '';

    if (cancelText) {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn--ghost ui-modal__btn';
      cancelBtn.textContent = cancelText;
      cancelBtn.addEventListener('click', () => close(false));
      actions.appendChild(cancelBtn);
    }

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = danger ? 'btn btn--primary ui-modal__btn ui-modal__btn--danger' : 'btn btn--primary ui-modal__btn';
    okBtn.textContent = confirmText;
    okBtn.addEventListener('click', () => close(true));
    actions.appendChild(okBtn);

    root.classList.remove('hidden');
    document.body.classList.add('ui-modal-open');
    setTimeout(() => okBtn.focus(), 0);

    return new Promise((resolve) => {
      resolveFn = resolve;
    });
  }

  function alert(message, opts = {}) {
    return open({
      title: opts.title || '안내',
      message,
      confirmText: opts.confirmText || '확인',
      cancelText: null,
    }).then(() => undefined);
  }

  function confirm(message, opts = {}) {
    return open({
      title: opts.title || '확인',
      message,
      confirmText: opts.confirmText || '확인',
      cancelText: opts.cancelText || '취소',
      danger: !!opts.danger,
    });
  }

  return { open, alert, confirm, close };
})();

window.UiModal = UiModal;
