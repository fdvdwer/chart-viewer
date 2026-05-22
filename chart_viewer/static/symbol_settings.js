/**
 * symbol_settings.js — UI for editing per-symbol contract specs.
 *
 * Lives inside the existing chart-settings-modal as the "商品規格 /
 * Symbol Specs" nav item (data-section="symspec"). Two views:
 *
 *   list  — table of every symbol the user has data for OR the dictionary
 *           knows about. Click a row → edit view.
 *   edit  — form for one symbol's spec; Save calls SymbolSpecs.setOverride
 *           which PUTs to /api/symbol-specs/<sym>. "Reset to default"
 *           calls removeOverride (idempotent on the server).
 *
 * Spec persistence + dictionary merge live in symbol_specs.js. This
 * module is purely the UI layer; it never reads SYMBOL_SPECS directly
 * — always goes through SymbolSpecs.getSpec / getBuiltIn / hasOverride
 * so future schema changes only need to touch one place.
 *
 * Re-renders on i18n:change (new locale) and symbol_specs:changed (the
 * dictionary itself moved). Idempotent guard prevents listener stacking.
 */
(function () {
  'use strict';

  // Render this list in the dictionary-key column. Picked by spec
  // namespace, NOT alphabetical, so the form fields appear in a
  // sensible reading order: identity → multipliers → execution.
  const FORM_FIELDS = [
    'displayName', 'kind',
    'tickSize', 'pointValue', 'lotSize', 'qtyStep',
    'spread', 'slippageTicks', 'commissionPerSide',
    'currency',
  ];

  // i18n shortcut — same pattern other modules use. Reads
  // window.I18n.lang (not `this.lang`) so the alias is safe per
  // §4u boot-crash fix.
  function t_(key, vars) {
    return (window.I18n && window.I18n.t) ? window.I18n.t(key, vars) : key;
  }

  // Small inline toast — Toast in app.js isn't exposed on window.
  // Reuses the same #toast element; same auto-hide behavior.
  function toast(msg, kind = '', ms = 2200) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    if (toast._timer) clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  /** Format a number for display in the list cells. Trailing zeros
   *  trimmed so "1.0000" reads as "1" but "0.00005" stays full. */
  function _fmtNum(v) {
    if (v == null || !isFinite(v)) return '—';
    const s = Number(v).toString();
    return s;
  }

  const SymbolSettings = {
    _wired: false,
    _editingSymbol: null,

    init() {
      if (this._wired) return;
      this._wired = true;

      // Hook the modal's symspec nav item — when clicked, repopulate
      // the list. (drawing.js handles the section show/hide; we just
      // own the content render.)
      const modal = document.getElementById('chart-settings-modal');
      if (!modal) return;
      modal.querySelectorAll('.modal-nav-item[data-section="symspec"]').forEach((nav) => {
        nav.addEventListener('click', () => this.showList());
      });
      // If the modal opens with symspec already active (next time the
      // user opens settings after last using symspec), re-render too.
      // We piggyback on the existing chart-settings open path by
      // observing class mutations on the modal — cheap, single observer.
      const obs = new MutationObserver(() => {
        if (modal.classList.contains('hidden')) return;
        const active = modal.querySelector('.modal-nav-item.active');
        if (active && active.dataset.section === 'symspec') this.showList();
      });
      obs.observe(modal, { attributes: true, attributeFilter: ['class'] });

      // Edit-view buttons.
      const back = document.getElementById('symspec-back-btn');
      if (back) back.addEventListener('click', () => this.showList());

      const save = document.getElementById('symspec-save-btn');
      if (save) save.addEventListener('click', () => this._saveCurrent());

      const reset = document.getElementById('symspec-reset-btn');
      if (reset) reset.addEventListener('click', () => this._resetCurrent());

      // Currency dropdown — populate from SymbolSpecs.ALLOWED_CURRENCIES.
      const sel = document.querySelector('#symspec-form select[data-field="currency"]');
      if (sel && window.SymbolSpecs && window.SymbolSpecs.ALLOWED_CURRENCIES) {
        sel.innerHTML = window.SymbolSpecs.ALLOWED_CURRENCIES
          .map((c) => `<option value="${c}">${c}</option>`).join('');
      }

      // Re-render visible view on locale / dictionary changes.
      document.addEventListener('i18n:change', () => this._refreshVisible());
      document.addEventListener('symbol_specs:changed', () => this._refreshVisible());
    },

    /** Build the union of (chart symbols user has data for, dictionary
     *  base keys) and render one row per symbol. */
    showList() {
      this._editingSymbol = null;
      const list = document.querySelector('[data-symspec-view="list"]');
      const edit = document.querySelector('[data-symspec-view="edit"]');
      if (list) list.classList.remove('hidden');
      if (edit) edit.classList.add('hidden');
      this._renderList();
    },

    _renderList() {
      const tbody = document.getElementById('symspec-list-tbody');
      if (!tbody || !window.SymbolSpecs) return;

      // Union of dictionary base keys + chart symbols (resolved to
      // their base key). User-data symbols whose base isn't in the
      // dictionary land in the table as "Not set" rows so the user
      // can spot them and configure.
      const dictKeys = new Set(window.SymbolSpecs.listSymbols());
      const chartSymbols = (window.App && Array.isArray(window.App.symbols))
        ? window.App.symbols : [];
      const baseFor = (s) => window.SymbolSpecs.resolveBaseKey(s);
      const orphans = new Set();   // chart symbols whose base has no built-in/override
      const rows = [];

      // Dictionary entries first (alphabetical).
      const sortedDict = Array.from(dictKeys).sort();
      for (const key of sortedDict) {
        const spec = window.SymbolSpecs.getSpec(key);
        const isOverride = window.SymbolSpecs.hasOverride(key);
        const isBuiltIn = !!window.SymbolSpecs.getBuiltIn(key);
        rows.push({ key, spec, status: isOverride ? 'override' : (isBuiltIn ? 'builtin' : 'unknown') });
      }
      // Then orphan chart symbols (no spec entry at all — fall back
      // to NQ defaults; user should configure).
      for (const sym of chartSymbols) {
        const base = baseFor(sym);
        if (!dictKeys.has(base)) orphans.add(base);
      }
      for (const key of Array.from(orphans).sort()) {
        const fallback = window.SymbolSpecs.getSpec(key);     // = NQ defaults
        rows.push({ key, spec: fallback, status: 'unknown' });
      }

      const fmtMoney = (v, cur) =>
        (window.SymbolSpecs.formatMoney) ? window.SymbolSpecs.formatMoney(v, cur, { decimals: 0 })
                                         : `${cur} ${v}`;

      tbody.innerHTML = '';
      for (const { key, spec, status } of rows) {
        const tr = document.createElement('tr');
        tr.className = 'symspec-row' + (status === 'unknown' ? ' is-unknown' : '');
        tr.dataset.symbol = key;
        const statusLabel = status === 'override' ? t_('panel.symspec.statusOverride')
                          : status === 'unknown'  ? t_('panel.symspec.statusUnknown')
                                                  : t_('panel.symspec.statusBuiltin');
        const statusClass = status === 'override' ? 'is-override'
                          : status === 'unknown'  ? 'is-unknown'
                                                  : 'is-builtin';
        tr.innerHTML = `
          <td class="symspec-cell-symbol">${_escapeHTML(key)}</td>
          <td class="symspec-cell-name">${_escapeHTML(spec.displayName || '—')}</td>
          <td class="symspec-cell-num">${_fmtNum(spec.tickSize)}</td>
          <td class="symspec-cell-num">${_escapeHTML(fmtMoney(spec.pointValue, spec.currency || 'USD'))}</td>
          <td class="symspec-cell-currency">${_escapeHTML(spec.currency || 'USD')}</td>
          <td class="symspec-cell-status"><span class="symspec-status ${statusClass}">${_escapeHTML(statusLabel)}</span></td>
        `;
        tr.addEventListener('click', () => this.showEdit(key));
        tbody.appendChild(tr);
      }
    },

    /** Populate the edit form for a given symbol. */
    showEdit(symbolKey) {
      if (!window.SymbolSpecs) return;
      const key = window.SymbolSpecs.resolveBaseKey(symbolKey);
      this._editingSymbol = key;

      const spec = window.SymbolSpecs.getSpec(key);
      const titleEl = document.getElementById('symspec-edit-title');
      if (titleEl) titleEl.textContent = t_('panel.symspec.editTitle', { symbol: key });

      const form = document.getElementById('symspec-form');
      if (!form) return;
      for (const field of FORM_FIELDS) {
        const input = form.querySelector(`[data-field="${field}"]`);
        if (!input) continue;
        const v = spec[field];
        if (input.tagName === 'SELECT') {
          input.value = v != null ? String(v) : '';
        } else {
          input.value = v != null ? String(v) : '';
        }
      }
      // Reset button is meaningful only when an override exists; show
      // it greyed-out otherwise so the user understands the state.
      const resetBtn = document.getElementById('symspec-reset-btn');
      if (resetBtn) {
        resetBtn.disabled = !window.SymbolSpecs.hasOverride(key);
      }

      const list = document.querySelector('[data-symspec-view="list"]');
      const edit = document.querySelector('[data-symspec-view="edit"]');
      if (list) list.classList.add('hidden');
      if (edit) edit.classList.remove('hidden');
    },

    async _saveCurrent() {
      if (!this._editingSymbol || !window.SymbolSpecs) return;
      const key = this._editingSymbol;
      const form = document.getElementById('symspec-form');
      if (!form) return;
      const partial = {};
      for (const field of FORM_FIELDS) {
        const input = form.querySelector(`[data-field="${field}"]`);
        if (!input) continue;
        const raw = input.value;
        if (raw === '' || raw == null) continue;
        if (input.type === 'number') {
          const num = parseFloat(raw);
          if (Number.isFinite(num)) partial[field] = num;
        } else {
          partial[field] = String(raw).trim();
        }
      }
      const ok = await window.SymbolSpecs.setOverride(key, partial);
      if (ok) {
        toast(t_('panel.symspec.savedToast', { symbol: key }), 'success');
        this.showList();
      } else {
        toast(t_('panel.symspec.saveFailedToast'), 'error', 3000);
      }
    },

    async _resetCurrent() {
      if (!this._editingSymbol || !window.SymbolSpecs) return;
      const key = this._editingSymbol;
      const msg = t_('panel.symspec.confirmReset', { symbol: key });
      if (!window.confirm(msg)) return;
      const ok = await window.SymbolSpecs.removeOverride(key);
      if (ok) {
        toast(t_('panel.symspec.resetToast', { symbol: key }), 'success');
        this.showList();
      } else {
        toast(t_('panel.symspec.saveFailedToast'), 'error', 3000);
      }
    },

    /** Re-render whichever view is visible — called on i18n:change /
     *  symbol_specs:changed events. */
    _refreshVisible() {
      const modal = document.getElementById('chart-settings-modal');
      if (!modal || modal.classList.contains('hidden')) return;
      const active = modal.querySelector('.modal-nav-item.active');
      if (!active || active.dataset.section !== 'symspec') return;
      if (this._editingSymbol) this.showEdit(this._editingSymbol);
      else this._renderList();
    },
  };

  function _escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.SymbolSettings = SymbolSettings;
})();
