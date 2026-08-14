/* ============================================================================
 * indicator_library.js — "Add indicator" dialog (search + flat list)
 * ============================================================================
 * Per indicator-manager-spec §5: this is the ADD-indicator entry point.
 * It is a local storage view — STRICTLY:
 *   ✓ a search box
 *   ✓ a flat list of available indicators (name + small "add" affordance)
 *   ✗ NO favourites / my-scripts / purchased / community / editor's picks
 *     / trending / store / author column / likes column
 * The user explicitly rejected the social/discovery surface that
 * TradingView's indicator dialog has — keep this minimal.
 *
 * Wired by the toolbar's "技術指標" button (added in index.html, click
 * handler in app.js → IndicatorLibrary.open()).
 * ========================================================================== */

(function () {
  const LIB = {
    el: null,
    searchEl: null,
    listEl: null,
    _wired: false,
  };

  function _t(key, fallback) {
    return (window.I18n && window.I18n.t)
      ? (window.I18n.t(key) || fallback)
      : fallback;
  }

  function init() {
    if (LIB._wired) return;
    LIB.el       = document.getElementById('indicator-library');
    if (!LIB.el) return;
    LIB.searchEl = document.getElementById('ind-lib-search');
    LIB.listEl   = document.getElementById('ind-lib-list');
    LIB._wired = true;

    document.getElementById('ind-lib-close').addEventListener('click', close);
    LIB.searchEl.addEventListener('input', _renderList);

    // Esc closes.
    document.addEventListener('keydown', (e) => {
      if (!isOpen()) return;
      if (e.key === 'Escape') { close(); e.preventDefault(); }
    });
    // Outside-click closes.
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (!isOpen()) return;
      if (LIB.el.contains(e.target)) return;
      // Allow toolbar button to drive its own open() — but don't close
      // when the click that opened us has just bubbled here.
      if (e.target.closest('#btn-indicator-library')) return;
      close();
    }, true);
  }

  function isOpen() {
    return LIB.el && !LIB.el.classList.contains('hidden');
  }

  function open() {
    init();
    if (!LIB.el) return;
    LIB.searchEl.value = '';
    _renderList();
    LIB.el.classList.remove('hidden');
    LIB.el.setAttribute('aria-hidden', 'false');
    setTimeout(() => LIB.searchEl.focus(), 50);
  }

  function close() {
    // Release focus from the search input BEFORE hiding the dialog —
    // otherwise document.activeElement stays on the hidden <input>,
    // which makes isFormFocused() return true in app.js's global
    // keydown handler and swallows digit-key TF switching + alpha-key
    // symbol search.
    if (document.activeElement && LIB.el && LIB.el.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    if (LIB.el) {
      LIB.el.classList.add('hidden');
      LIB.el.setAttribute('aria-hidden', 'true');
    }
  }

  function _renderList() {
    if (!LIB.listEl) return;
    LIB.listEl.innerHTML = '';
    const registry = window.IndicatorManager
      ? window.IndicatorManager.getRegistry()
      : {};
    const q = (LIB.searchEl.value || '').trim().toLowerCase();
    const entries = Object.values(registry).filter(e =>
      !q || (e.name && e.name.toLowerCase().includes(q))
           || (e.type && e.type.toLowerCase().includes(q))
    );

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ind-lib-empty';
      empty.textContent = q
        ? `沒有符合「${q}」的指標`
        : '尚未註冊任何指標';
      LIB.listEl.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ind-lib-row';
      const name = document.createElement('span');
      name.className = 'ind-lib-row-name';
      name.textContent = entry.name || entry.type;
      const add = document.createElement('span');
      add.className = 'ind-lib-row-add';
      add.textContent = '＋';
      row.appendChild(name);
      row.appendChild(add);
      row.addEventListener('click', () => {
        if (window.IndicatorManager) {
          window.IndicatorManager.addIndicator(entry.type);
        }
        close();
      });
      LIB.listEl.appendChild(row);
    }
  }

  window.IndicatorLibrary = { init, open, close, isOpen };
})();
