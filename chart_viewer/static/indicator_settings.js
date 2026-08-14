/* ============================================================================
 * indicator_settings.js — reusable schema-driven settings dialog
 * ============================================================================
 * Renders an inputs panel for one indicator instance, driven by the
 * indicator's `paramSchema` (declared in static/indicators/*.js). Same DOM
 * shell as the chart_viewer's other "settings popovers" (fibo, position) so
 * the dark-theme look + drag-by-header behaviour matches.
 *
 * Public API (called by IndicatorManager):
 *   IndicatorSettings.init()
 *       Wires the DOM once. Idempotent.
 *
 *   IndicatorSettings.open(instance, registryEntry, onApply, onCancel)
 *       Opens the dialog for a specific indicator instance.
 *         instance       — { id, type, params, visible, kline_id }
 *         registryEntry  — SwingPivotIndicator (or other type's registry obj)
 *         onApply(params)  — called on Defaults change + live every input change
 *                            AND on OK. Caller decides what "apply" means
 *                            (typically: update calc + redraw + persist).
 *         onCancel(snapshotParams) — called on Cancel / Esc / ✕ / outside-click.
 *                                     Caller restores the snapshot.
 *
 *  Schema entry shape:
 *    { key, label, type, default, [min, max] }
 *    type ∈ 'int' | 'number' | 'bool'
 *  (extend later if a new indicator needs e.g. 'enum' or 'color').
 * ========================================================================== */

(function () {
  // Templates ride on the SAME backend file as drawing templates
  // (`/api/templates` → user_data/templates.json), under buckets prefixed
  // with `indicator:` so they don't collide with the drawing buckets
  // (`trendline_snap` / `rectangle_snap` / `path_done` / etc.). The
  // localStorage cache key is also shared with drawing.js, so one
  // _syncTemplatesFromServer() pass on boot warms both modules' caches.
  const TPL_STORE_KEY = 'chart_viewer_drawing_templates_v2';
  const TPL_BUCKET_PREFIX = 'indicator:';

  function _bucketKey(type) { return TPL_BUCKET_PREFIX + type; }

  function _loadAllTpls() {
    try { return JSON.parse(localStorage.getItem(TPL_STORE_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function _saveAllTpls(all) {
    try { localStorage.setItem(TPL_STORE_KEY, JSON.stringify(all)); } catch (e) {}
    try {
      fetch('/api/templates', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(all),
      });
    } catch (e) {}
  }
  function _getTplsFor(type) {
    if (!type) return [];
    const all = _loadAllTpls();
    return Array.isArray(all[_bucketKey(type)]) ? all[_bucketKey(type)] : [];
  }
  function _setTplsFor(type, list) {
    if (!type) return;
    const all = _loadAllTpls();
    all[_bucketKey(type)] = list;
    _saveAllTpls(all);
  }
  // Pull /api/templates on init so freshly-launched session sees
  // server-side templates even before drawing.js runs its own sync
  // (boot order has drawing.js earlier, but we defend against ordering
  // changes in the future).
  async function _syncFromServer() {
    try {
      const r = await fetch('/api/templates');
      if (!r.ok) return;
      const server = await r.json();
      if (!server || typeof server !== 'object') return;
      const cache = _loadAllTpls();
      // Adopt server's indicator: buckets unconditionally — they are the
      // source of truth across machines. Keep drawing buckets that may
      // only exist in cache.
      let touched = false;
      for (const k of Object.keys(server)) {
        if (k.startsWith(TPL_BUCKET_PREFIX)) {
          cache[k] = server[k];
          touched = true;
        }
      }
      if (touched) {
        try { localStorage.setItem(TPL_STORE_KEY, JSON.stringify(cache)); } catch (e) {}
      }
    } catch (e) { /* offline → stay with cache */ }
  }

  const SP = {
    el: null,
    titleEl: null,
    bodyEl: null,
    instance: null,
    schema: null,
    snapshot: null,         // deep clone of params at open() — for Cancel revert
    registryEntry: null,    // needed to know `type` for template bucket
    onApply: null,
    onCancel: null,
    activeTab: 0,           // index into section-grouped tabs (when schema has ≥2 sections)
    _wired: false,
    _draggingState: null,
  };

  function _t(key, fallback) {
    return (window.I18n && window.I18n.t)
      ? window.I18n.t(key) || fallback
      : fallback;
  }

  function init() {
    if (SP._wired) return;
    SP.el = document.getElementById('indicator-settings');
    if (!SP.el) return;
    SP.titleEl = document.getElementById('ind-settings-title');
    SP.bodyEl  = document.getElementById('ind-settings-body');
    SP._wired = true;

    document.getElementById('ind-settings-close').addEventListener('click', cancel);
    document.getElementById('ind-settings-cancel').addEventListener('click', cancel);
    document.getElementById('ind-settings-ok').addEventListener('click', confirm);

    _wireTemplateUI();
    _syncFromServer();   // warm the cache; fire-and-forget

    // Header drag — same pattern as PositionOverlaySettings / FiboSettings.
    _installDrag();

    // Esc closes (= Cancel). Enter = Confirm (user can tab between
    // fields and finalise without reaching for the mouse). Both are
    // gated by sub-overlay visibility so they don't fight nested UI:
    //   - Name modal has its own Enter handler (saves template)
    //   - Template popover lists exist for click selection only
    //   - Color popover swallows Enter for its own input
    //   - TEXTAREA fields keep Enter for newlines
    document.addEventListener('keydown', (e) => {
      if (!isOpen()) return;
      if (e.key === 'Escape') {
        // Esc also gated — if any nested overlay is open, let it handle
        // Esc itself (close the sub-overlay first, then the dialog)
        const nameModal = document.getElementById('ind-tpl-name-modal');
        if (nameModal && !nameModal.classList.contains('hidden')) return;
        const tplPop = document.getElementById('ind-settings-tpl-pop');
        if (tplPop && !tplPop.classList.contains('hidden')) return;
        cancel();
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter') {
        if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
        const nameModal = document.getElementById('ind-tpl-name-modal');
        if (nameModal && !nameModal.classList.contains('hidden')) return;
        const tplPop = document.getElementById('ind-settings-tpl-pop');
        if (tplPop && !tplPop.classList.contains('hidden')) return;
        const colorPop = document.getElementById('sp-color-pop');
        if (colorPop && !colorPop.classList.contains('hidden')) return;
        // Blur the currently-focused input first so any pending 'input'
        // event is committed before confirm() snapshots the params.
        if (document.activeElement && SP.el && SP.el.contains(document.activeElement)) {
          document.activeElement.blur();
        }
        confirm();
        e.preventDefault();
      }
    });

    // Outside-click closes (= Cancel) — capture phase so we beat KLineChart
    // mouse handling. Skip when click is on:
    //   - the dialog itself
    //   - the body-level generic color popover (#sp-color-pop) that we
    //     spawned via Drawing.openGenericColorPicker (children of body,
    //     NOT inside SP.el → would otherwise trip the close)
    //   - any .color-swatch button (the popover's anchor click)
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (!isOpen()) return;
      if (SP.el.contains(e.target)) return;
      const colorPop = document.getElementById('sp-color-pop');
      if (colorPop && !colorPop.classList.contains('hidden') && colorPop.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.color-swatch')) return;
      // Template popover + save-as modal are DOM siblings of the dialog
      // (positioned outside SP.el to avoid z-index nesting issues). Without
      // these guards, clicking "另存為..." inside the popover, or any field
      // inside the save modal, would trip this outside-click handler and
      // cancel the parent dialog — killing the save flow before the user
      // could even type a name.
      if (e.target.closest && e.target.closest('#ind-settings-tpl-pop')) return;
      if (e.target.closest && e.target.closest('#ind-tpl-name-modal'))  return;
      cancel();
    }, true);
  }

  function isOpen() {
    return SP.el && !SP.el.classList.contains('hidden');
  }

  function _recenter() {
    if (!SP.el) return;
    SP.el.style.left = '';
    SP.el.style.top = '';
    SP.el.style.transform = '';
  }

  function _installDrag() {
    const header = SP.el && SP.el.querySelector('header');
    if (!header) return;
    let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button')) return;
      const rect = SP.el.getBoundingClientRect();
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      sl = rect.left; st = rect.top;
      SP.el.style.left = sl + 'px';
      SP.el.style.top  = st + 'px';
      SP.el.style.transform = 'none';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      SP.el.style.left = (sl + e.clientX - sx) + 'px';
      SP.el.style.top  = (st + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) document.body.style.userSelect = '';
      dragging = false;
    });
  }

  function _renderField(entry, currentValue) {
    // 'section' entries are non-input headers used to group related rows
    // (e.g. "頂部 pivot" / "底部 pivot" in Swing Pivot). They contribute
    // nothing to the collected params.
    if (entry.type === 'section') {
      const sec = document.createElement('div');
      sec.className = 'ind-settings-section';
      sec.textContent = entry.label;
      return sec;
    }

    // currentValue may be undefined if the instance lacks the key (legacy
    // config from a schema-extension); fall back to default.
    const v = currentValue !== undefined ? currentValue : entry.default;
    const row = document.createElement('div');
    row.className = 'row ind-settings-row';
    const label = document.createElement('label');
    label.textContent = entry.label;
    row.appendChild(label);

    let input;
    if (entry.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!v;
      input.className = 'ind-settings-input';
      input.dataset.key = entry.key;
      input.dataset.type = 'bool';
    } else if (entry.type === 'enum') {
      input = document.createElement('select');
      input.className = 'ind-settings-input';
      input.dataset.key = entry.key;
      input.dataset.type = 'enum';
      for (const opt of (entry.options || [])) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label || opt.value;
        if (opt.value === v) o.selected = true;
        input.appendChild(o);
      }
    } else if (entry.type === 'color') {
      // Use the chart-wide generic palette popover (same UI as the
      // drawing / chart-settings swatches) instead of a native
      // <input type="color">. Single swatch button: click → opens
      // popover; selection in popover → callback fires with new hex;
      // we mirror it to dataset + bg + fire _applyLive.
      input = document.createElement('button');
      input.type = 'button';
      input.className = 'color-swatch ind-settings-input ind-settings-color';
      input.dataset.key = entry.key;
      input.dataset.type = 'color';
      input.dataset.color = v || '#000000';
      input.style.background = v || '#000000';
      input.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!window.Drawing || !window.Drawing.openGenericColorPicker) return;
        const cur = input.dataset.color || (v || '#000000');
        window.Drawing.openGenericColorPicker(input, cur, 1, (newHex) => {
          input.dataset.color = newHex;
          input.style.background = newHex;
          _applyLive();
        });
      });
    } else {
      // 'int' / 'number' / default
      input = document.createElement('input');
      input.type = 'number';
      input.value = (v == null) ? '' : v;
      if (entry.min != null) input.min = entry.min;
      if (entry.max != null) input.max = entry.max;
      input.step = (entry.type === 'int') ? '1' : 'any';
      input.className = 'ind-settings-input';
      input.dataset.key = entry.key;
      input.dataset.type = entry.type;
    }

    // Color inputs have already wired their own click → openGenericColorPicker
    // handler above; skip the generic change/input listeners (the
    // callback fires _applyLive itself when the palette returns a hex).
    if (entry.type !== 'color') {
      input.addEventListener('change', _applyLive);
      // For non-toggle / non-enum inputs, also live-fire on text typing.
      if (entry.type !== 'bool' && entry.type !== 'enum') {
        input.addEventListener('input', _applyLive);
      }
    }

    row.appendChild(input);
    return row;
  }

  function _collectParams() {
    // START from the full current params, then overlay the DOM values.
    // CRITICAL for tabbed panels: _renderBody renders ONLY the active tab's
    // inputs into the DOM, so querySelectorAll below sees just that tab. If we
    // started from {} we'd drop every OTHER tab's param → applyParams merges
    // them back from DEFAULT_PARAMS → silently resets them (e.g. changing a
    // field on the 範圍 tab would reset min_swing on the 結構 tab to default,
    // which is why reverting one control couldn't restore the original view).
    // Flat panels render all inputs, so overlaying is a no-op difference there.
    const out = { ...(SP.instance && SP.instance.params ? SP.instance.params : {}) };
    if (!SP.bodyEl) return out;
    const findEntry = (key) => SP.schema.find(s => s.key === key);
    for (const input of SP.bodyEl.querySelectorAll('.ind-settings-input')) {
      const key  = input.dataset.key;
      const type = input.dataset.type;
      if (type === 'bool') {
        out[key] = input.checked;
      } else if (type === 'color') {
        // Color swatches store the hex on dataset.color (NOT input.value —
        // that would be the rendered background, possibly an rgba string).
        out[key] = input.dataset.color || (findEntry(key) || {}).default;
      } else if (type === 'enum') {
        out[key] = input.value;
      } else if (type === 'int') {
        const n = parseInt(input.value, 10);
        out[key] = Number.isFinite(n) ? n : (findEntry(key) || {}).default;
      } else {
        const n = parseFloat(input.value);
        out[key] = Number.isFinite(n) ? n : (findEntry(key) || {}).default;
      }
    }
    return out;
  }

  function _applyLive() {
    if (!SP.instance || !SP.onApply) return;
    const params = _collectParams();
    SP.instance.params = params;
    try { SP.onApply(params); } catch (e) { /* ignore */ }
  }

  function open(instance, registryEntry, onApply, onCancel) {
    init();   // idempotent
    if (!SP.el) return;
    SP.instance = instance;
    SP.schema   = registryEntry.paramSchema || [];
    SP.snapshot = JSON.parse(JSON.stringify(instance.params || {}));
    SP.registryEntry = registryEntry;
    SP.onApply  = onApply;
    SP.onCancel = onCancel;

    SP.titleEl.textContent = registryEntry.name + ' — 設定';
    SP.activeTab = 0;          // reset to first tab on every open
    _renderBody();

    _recenter();
    SP.el.classList.remove('hidden');
    SP.el.setAttribute('aria-hidden', 'false');
  }

  function confirm() {
    // applyLive has been pushing every keystroke, so OK is just close.
    // Caller-supplied onApply has already fired; we don't re-call it here.
    _close();
  }

  function cancel() {
    if (!SP.instance) { _close(); return; }
    // Revert to snapshot.
    SP.instance.params = JSON.parse(JSON.stringify(SP.snapshot || {}));
    if (SP.onCancel) {
      try { SP.onCancel(SP.instance.params); } catch (e) { /* ignore */ }
    }
    _close();
  }

  function resetDefaults() {
    if (!SP.schema) return;
    const defaults = {};
    for (const s of SP.schema) defaults[s.key] = s.default;
    _applyParamsToDialog(defaults);
  }

  function _applyParamsToDialog(params) {
    // Push `params` into both the instance and the rendered inputs, then
    // fire onApply so the chart redraws. Used by Apply Default and by
    // template-load.
    if (!SP.schema) return;
    SP.instance.params = { ...params };
    _renderBody();
    if (SP.onApply) {
      try { SP.onApply(SP.instance.params); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Render dialog body. Two modes:
   *   - Tab mode (OPT-IN via `registryEntry.tabbedPanel === true`): groups
   *     fields by `section` entries and renders a tab strip. Each
   *     section becomes a tab; click to switch. Use a short `tabLabel`
   *     on the section entry when the section header itself is long.
   *   - Flat mode (default): render all fields in order, section
   *     dividers shown inline. Used by simple indicators (Swing Pivot,
   *     N Wave, MicroPivot, BOS/CHoCh) where fields fit comfortably.
   *
   * Decision is per-indicator on the registry, not based on section
   * count. Indicators with many short sections still render flat (which
   * is fine); indicators that EXPLICITLY want tabs (e.g. Supply/Demand
   * Zones with 6 sections × ~5 params each) opt in.
   */
  function _renderBody() {
    if (!SP.bodyEl || !SP.schema) return;
    SP.bodyEl.innerHTML = '';

    const tabbed = !!(SP.registryEntry && SP.registryEntry.tabbedPanel);

    if (!tabbed) {
      // Flat mode — original behaviour, no tab strip.
      for (const entry of SP.schema) {
        const cur = SP.instance && SP.instance.params ? SP.instance.params[entry.key] : undefined;
        SP.bodyEl.appendChild(_renderField(entry, cur));
      }
      return;
    }

    // Tab mode — group entries by their preceding `section` entry.
    const groups = [];
    let current = null;
    for (const entry of SP.schema) {
      if (entry.type === 'section') {
        current = { label: entry.tabLabel || entry.label, entries: [] };
        groups.push(current);
      } else {
        if (!current) {
          current = { label: '一般', entries: [] };
          groups.push(current);
        }
        current.entries.push(entry);
      }
    }

    const useTabs = groups.length >= 2;

    if (useTabs) {
      // Tab strip — reuses `.settings-popover .tabs .tab` CSS from
      // position-overlay-settings styling.
      const nav = document.createElement('nav');
      nav.className = 'tabs';
      groups.forEach((g, idx) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'tab' + (idx === SP.activeTab ? ' active' : '');
        tab.textContent = g.label;
        tab.addEventListener('click', (e) => {
          e.stopPropagation();
          SP.activeTab = idx;
          _renderBody();
        });
        nav.appendChild(tab);
      });
      SP.bodyEl.appendChild(nav);

      const safeIdx = Math.min(SP.activeTab, groups.length - 1);
      const active = groups[safeIdx];
      for (const entry of active.entries) {
        const cur = SP.instance && SP.instance.params ? SP.instance.params[entry.key] : undefined;
        SP.bodyEl.appendChild(_renderField(entry, cur));
      }
    } else {
      // Flat — original behaviour for simple indicators (Swing Pivot etc).
      for (const entry of SP.schema) {
        const cur = SP.instance && SP.instance.params ? SP.instance.params[entry.key] : undefined;
        SP.bodyEl.appendChild(_renderField(entry, cur));
      }
    }
  }

  // ===========================================================================
  // Template UI
  // ===========================================================================
  function _wireTemplateUI() {
    const tplBtn = document.getElementById('ind-settings-tpl-btn');
    const pop    = document.getElementById('ind-settings-tpl-pop');
    const modal  = document.getElementById('ind-tpl-name-modal');
    if (!tplBtn || !pop || !modal) return;

    // Toggle popover
    tplBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pop.classList.contains('hidden')) _showTplPopover();
      else _hideTplPopover();
    });

    // Outside-click closes popover (capture phase, like drawing's)
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (pop.classList.contains('hidden')) return;
      if (pop.contains(e.target)) return;
      if (e.target.closest('#ind-settings-tpl-btn')) return;
      _hideTplPopover();
    }, true);

    // Popover actions: save-as / apply-defaults
    pop.querySelectorAll('.tpl-action').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = el.dataset.act;
        if (act === 'save-as') {
          _hideTplPopover();
          _showNameModal();
        } else if (act === 'apply-defaults') {
          resetDefaults();
          _hideTplPopover();
        }
      });
    });

    // Name modal — close / cancel / confirm / Enter / Esc + chevron
    const nameInput   = document.getElementById('ind-tpl-name-input');
    const confirmBtn  = document.getElementById('ind-tpl-name-confirm');
    const cancelBtn   = document.getElementById('ind-tpl-name-cancel');
    const closeBtn    = document.getElementById('ind-tpl-name-close');
    const chevronBtn  = document.getElementById('ind-tpl-name-dropdown-btn');
    const existingEl  = document.getElementById('ind-tpl-name-existing');

    if (closeBtn) closeBtn.addEventListener('click', _hideNameModal);
    if (cancelBtn) cancelBtn.addEventListener('click', _hideNameModal);
    if (nameInput) {
      nameInput.addEventListener('input', () => {
        confirmBtn.disabled = !nameInput.value.trim();
        if (existingEl) existingEl.classList.add('hidden');
      });
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !confirmBtn.disabled) {
          e.preventDefault();
          confirmBtn.click();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          _hideNameModal();
        }
      });
    }
    if (chevronBtn) {
      chevronBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!existingEl) return;
        if (existingEl.classList.contains('hidden')) _renderExistingNames();
        else existingEl.classList.add('hidden');
      });
    }
    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => {
        const name = (nameInput.value || '').trim();
        if (!name) return;
        _saveAsTemplate(name);
        _hideNameModal();
      });
    }
  }

  function _renderExistingNames() {
    const wrap  = document.getElementById('ind-tpl-name-existing');
    const input = document.getElementById('ind-tpl-name-input');
    if (!wrap || !input) return;
    const type  = SP.instance && SP.instance.type;
    const tpls  = _getTplsFor(type);
    wrap.innerHTML = '';
    if (!tpls.length) {
      const e = document.createElement('div');
      e.className = 'tpl-empty';
      e.textContent = _t('panel.drawing.tplEmpty', '（尚無模板）');
      wrap.appendChild(e);
    } else {
      for (const t of tpls) {
        const row = document.createElement('div');
        row.className = 'tpl-item';
        row.textContent = t.name;
        row.addEventListener('click', () => {
          input.value = t.name;
          document.getElementById('ind-tpl-name-confirm').disabled = !t.name;
          wrap.classList.add('hidden');
        });
        wrap.appendChild(row);
      }
    }
    wrap.classList.remove('hidden');
  }

  function _showTplPopover() {
    const pop = document.getElementById('ind-settings-tpl-pop');
    const btn = document.getElementById('ind-settings-tpl-btn');
    if (!pop || !btn) return;
    _renderTplList();
    pop.classList.remove('hidden');
    // DROPDOWN: open downward from the button by default — matches user
    // expectation of a "下拉式選單". Flip upward ONLY if not enough room
    // below the button (rare; happens when dialog is dragged near the
    // bottom of the viewport).
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let top = r.bottom + 4;                       // primary: drop down
    if (top + h > window.innerHeight - 5) {
      top = Math.max(5, r.top - h - 4);           // fallback: flip up
    }
    let left = r.left;
    if (left + w > window.innerWidth - 5) left = window.innerWidth - w - 5;
    pop.style.left = Math.max(5, left) + 'px';
    pop.style.top  = top + 'px';
  }
  function _hideTplPopover() {
    const pop = document.getElementById('ind-settings-tpl-pop');
    if (pop) pop.classList.add('hidden');
  }

  function _renderTplList() {
    const list = document.getElementById('ind-settings-tpl-list');
    if (!list) return;
    list.innerHTML = '';
    const type = SP.instance && SP.instance.type;
    const tpls = _getTplsFor(type);
    if (!tpls.length) return;     // no templates → nothing to show
    // Optional separator above saved list (matches drawing's look)
    const sep = document.createElement('div');
    sep.className = 'tpl-sep';
    list.appendChild(sep);
    const delLabel = _t('panel.drawing.tplDelete', '刪除');
    for (const t of tpls) {
      const row = document.createElement('div');
      row.className = 'tpl-item';
      row.innerHTML = `<span class="tpl-name"></span><span class="tpl-del" title="${delLabel}">✕</span>`;
      row.querySelector('.tpl-name').textContent = t.name;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.tpl-del')) return;
        _applyTemplate(t);
        _hideTplPopover();
      });
      row.querySelector('.tpl-del').addEventListener('click', (e) => {
        e.stopPropagation();
        const remaining = _getTplsFor(type).filter(x => x.name !== t.name);
        _setTplsFor(type, remaining);
        _renderTplList();
      });
      list.appendChild(row);
    }
  }

  function _showNameModal() {
    const modal      = document.getElementById('ind-tpl-name-modal');
    const input      = document.getElementById('ind-tpl-name-input');
    const confirmBtn = document.getElementById('ind-tpl-name-confirm');
    const existingEl = document.getElementById('ind-tpl-name-existing');
    if (!modal || !input || !confirmBtn) return;
    input.value = '';
    confirmBtn.disabled = true;
    if (existingEl) existingEl.classList.add('hidden');
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);
  }
  function _hideNameModal() {
    const modal      = document.getElementById('ind-tpl-name-modal');
    const existingEl = document.getElementById('ind-tpl-name-existing');
    if (existingEl) existingEl.classList.add('hidden');
    if (modal) modal.classList.add('hidden');
  }

  function _saveAsTemplate(name) {
    if (!SP.instance) return;
    const type = SP.instance.type;
    if (!type) return;
    const params = _collectParams();
    const list = _getTplsFor(type);
    const idx = list.findIndex(t => t.name === name);
    const entry = { name, params };
    if (idx >= 0) list[idx] = entry;     // overwrite by name
    else          list.push(entry);
    _setTplsFor(type, list);
  }

  function _applyTemplate(tpl) {
    if (!tpl || !tpl.params) return;
    // Fill any missing keys from schema defaults so templates saved
    // before a param was added still apply cleanly.
    const merged = {};
    for (const s of SP.schema) {
      merged[s.key] = (s.type === 'section') ? undefined
        : (tpl.params[s.key] !== undefined ? tpl.params[s.key] : s.default);
    }
    _applyParamsToDialog(merged);
  }

  function _close() {
    // Release focus from any input inside the dialog BEFORE hiding —
    // otherwise document.activeElement stays on a hidden <input> /
    // <select> and app.js's global keydown handler treats every digit
    // key as "form is focused, ignore", killing TF switching.
    if (document.activeElement && SP.el && SP.el.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    if (SP.el) {
      SP.el.classList.add('hidden');
      SP.el.setAttribute('aria-hidden', 'true');
    }
    // Also tear down any template UI that may still be open
    _hideTplPopover();
    _hideNameModal();
    SP.instance = null;
    SP.schema = null;
    SP.snapshot = null;
    SP.registryEntry = null;
    SP.onApply = null;
    SP.onCancel = null;
  }

  window.IndicatorSettings = { init, open, isOpen };
})();
