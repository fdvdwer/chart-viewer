/* ============================================================================
 * indicator_manager.js — chart-legend + indicator registry + persistence
 * ============================================================================
 * Chart-legend + indicator registry + persistence (indicator-manager-spec). Owns:
 *
 *   1. The indicator registry — a dict of available indicator types, each
 *      with its own detect / render / paramSchema. Swing Pivot is the
 *      only entry for v1; phase-2+ indicators (n_wave, bos_choch,
 *      supply_demand) register here too.
 *
 *   2. The active list — indicators currently on the chart, with their
 *      per-instance params, visibility, and KLineChart indicator id
 *      (returned by chart.createIndicator).
 *
 *   3. The top-left chart legend — one row per active indicator with
 *      hover-revealed icons (eye / gear / trash) matching the TV pattern.
 *      Collapse toggle shrinks the legend to `⌄ N` chip when N >= 2.
 *
 *   4. config.json persistence — round-trips the `indicators` block via
 *      /api/config so the chart restores the user's setup on reload.
 *
 * Architecture decision: KLineChart's built-in indicator system handles
 * the actual figures + recompute on data change, so the manager DOES NOT
 * draw markers itself — it just creates/removes/overrides KLineChart
 * indicators. This naturally gets us no-lookahead in replay mode (the
 * indicator's calc() runs over the current truncated dataList).
 * ========================================================================== */

(function () {
  const IM = {
    chart: null,
    registry: {},          // type_id → { type, name, defaultParams, paramSchema, add, remove, applyParams, klineTemplate }
    active: [],            // [{ id, type, params, visible, kline_id }]
    legendCollapsed: false,
    _legendEl: null,
    _hoverRow: null,       // currently-hovered legend row (for keyboard focus parity later)
    _saveTimer: null,
    _wired: false,
    _klineRegistered: new Set(),   // types whose KLineChart template has been registered
  };

  function _t(key, fallback) {
    return (window.I18n && window.I18n.t)
      ? (window.I18n.t(key) || fallback)
      : fallback;
  }

  // ---------- Registry ----------

  function registerType(entry) {
    if (!entry || !entry.type) return;
    IM.registry[entry.type] = entry;
    // Register the KLineChart template the first time this type appears.
    // klinecharts.registerIndicator is a global registration — once-only.
    if (entry.klineTemplate && !IM._klineRegistered.has(entry.type)) {
      try {
        klinecharts.registerIndicator(entry.klineTemplate);
        IM._klineRegistered.add(entry.type);
      } catch (e) {
        console.warn('[IndicatorManager] registerIndicator failed:', e);
      }
    }
  }

  function _newInstanceId(type) {
    // Stable per-load increment so two Swing Pivots get swing_pivot_1 /
    // swing_pivot_2. Reset is OK across reloads — they get re-derived
    // from config's `active` list.
    const taken = new Set(IM.active.map(a => a.id));
    let n = 1;
    while (taken.has(`${type}_${n}`)) n++;
    return `${type}_${n}`;
  }

  // ---------- Active list ops ----------

  function addIndicator(type, paramsOverride) {
    const entry = IM.registry[type];
    if (!entry) {
      console.warn('[IndicatorManager] unknown indicator type:', type);
      return null;
    }
    const params = { ...entry.defaultParams, ...(paramsOverride || {}) };
    const instance = {
      id: _newInstanceId(type),
      type,
      params,
      visible: true,
      kline_id: null,
    };
    // Pass the instance id so multi-instance-aware indicators (e.g. n_wave)
    // can key their KLineChart indicator uniquely instead of colliding on a
    // shared name. Legacy indicators ignore the extra arg. The return value is
    // an opaque handle we store as kline_id and hand back to remove/applyParams.
    instance.kline_id = entry.add(IM.chart, params, instance.id);
    IM.active.push(instance);
    _renderLegend();
    _schedulePersist();
    return instance;
  }

  function removeIndicator(instanceId) {
    const idx = IM.active.findIndex(a => a.id === instanceId);
    if (idx < 0) return;
    const inst = IM.active[idx];
    const entry = IM.registry[inst.type];
    if (entry && entry.remove) {
      entry.remove(IM.chart, inst.kline_id);
    }
    IM.active.splice(idx, 1);
    _renderLegend();
    _schedulePersist();
  }

  // Push the indicator instance's CURRENT state (params + visibility) to
  // KLineChart. Visibility and params travel together through one
  // applyParams call so the indicator's full extendData stays intact —
  // we never send a partial extendData that could wipe the colour /
  // type / width config (see swing_pivot.js's applyParams comment).
  function _flushToChart(instance) {
    const entry = IM.registry[instance.type];
    if (entry && entry.applyParams) {
      entry.applyParams(IM.chart, instance.kline_id, instance.params, instance.visible);
    }
  }

  function setVisibility(instanceId, visible) {
    const inst = IM.active.find(a => a.id === instanceId);
    if (!inst) return;
    inst.visible = !!visible;
    _flushToChart(inst);
    _renderLegend();
    _schedulePersist();
  }

  function _applyParams(instance, params) {
    instance.params = { ...params };
    _flushToChart(instance);
    _schedulePersist();
  }

  function openSettings(instanceId) {
    const inst = IM.active.find(a => a.id === instanceId);
    if (!inst) return;
    const entry = IM.registry[inst.type];
    if (!entry || !window.IndicatorSettings) return;
    window.IndicatorSettings.open(
      inst,
      entry,
      (newParams) => _applyParams(inst, newParams),
      (restoredParams) => _applyParams(inst, restoredParams),
    );
  }

  // ---------- Collapse toggle ----------

  function toggleCollapse() {
    IM.legendCollapsed = !IM.legendCollapsed;
    _renderLegend();
    _schedulePersist();
  }

  // ---------- Legend render ----------

  function _ensureLegend() {
    if (IM._legendEl) return IM._legendEl;
    const chartEl = document.getElementById('chart');
    if (!chartEl) return null;
    const el = document.createElement('div');
    el.id = 'indicator-legend';
    el.className = 'indicator-legend';
    chartEl.appendChild(el);
    IM._legendEl = el;
    return el;
  }

  function _renderLegend() {
    const el = _ensureLegend();
    if (!el) return;
    el.innerHTML = '';

    const n = IM.active.length;
    if (n === 0) {
      el.classList.add('empty');
      return;
    }
    el.classList.remove('empty');

    // Header: collapse chevron + (count when collapsed)
    const header = document.createElement('div');
    header.className = 'indicator-legend-header';

    if (IM.legendCollapsed && n >= 1) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'indicator-legend-chip';
      chip.innerHTML = `<span class="chev">⌄</span> <span class="count">${n}</span>`;
      chip.title = '展開指標列表';
      chip.addEventListener('click', toggleCollapse);
      header.appendChild(chip);
      el.appendChild(header);
      return;     // collapsed view = just the chip
    }

    // Expanded: per-indicator rows
    if (n >= 2) {
      const collapseBtn = document.createElement('button');
      collapseBtn.type = 'button';
      collapseBtn.className = 'indicator-legend-collapse';
      collapseBtn.innerHTML = '⌃';
      collapseBtn.title = '收合指標列表';
      collapseBtn.addEventListener('click', toggleCollapse);
      header.appendChild(collapseBtn);
      el.appendChild(header);
    }

    for (const inst of IM.active) {
      el.appendChild(_renderRow(inst));
    }
  }

  function _renderRow(instance) {
    const entry = IM.registry[instance.type] || {};
    const row = document.createElement('div');
    row.className = 'indicator-legend-row';
    row.dataset.id = instance.id;
    if (!instance.visible) row.classList.add('hidden-indicator');

    // Name (and we could add a live value readout in v2).
    const nameEl = document.createElement('span');
    nameEl.className = 'indicator-name';
    nameEl.textContent = entry.name || instance.type;
    row.appendChild(nameEl);

    // Hover icon strip
    const icons = document.createElement('span');
    icons.className = 'indicator-icons';

    // Eye toggle
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'indicator-icon-btn eye';
    eye.title = instance.visible ? '隱藏' : '顯示';
    eye.innerHTML = instance.visible
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17.94 17.94A10.06 10.06 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.4 18.4 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/><path d="M14.12 14.12a3 3 0 0 1-4.24-4.24"/></svg>';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      setVisibility(instance.id, !instance.visible);
    });
    icons.appendChild(eye);

    // Gear (settings)
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'indicator-icon-btn gear';
    gear.title = '設定';
    gear.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      openSettings(instance.id);
    });
    icons.appendChild(gear);

    // Trash (remove)
    const trash = document.createElement('button');
    trash.type = 'button';
    trash.className = 'indicator-icon-btn trash';
    trash.title = '移除指標';
    trash.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    trash.addEventListener('click', (e) => {
      e.stopPropagation();
      removeIndicator(instance.id);
    });
    icons.appendChild(trash);

    row.appendChild(icons);
    return row;
  }

  // ---------- Persistence ----------

  function _schedulePersist() {
    if (IM._saveTimer) clearTimeout(IM._saveTimer);
    IM._saveTimer = setTimeout(_persistNow, 250);
  }

  function _persistNow() {
    const payload = {
      indicators: {
        legend_collapsed: IM.legendCollapsed,
        active: IM.active.map(a => ({
          type:    a.type,
          id:      a.id,
          visible: a.visible,
          params:  a.params,
        })),
      },
    };
    try {
      fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => { /* network errors silent */ });
    } catch (e) { /* ignore */ }
  }

  async function _loadFromConfig() {
    try {
      const r = await fetch('/api/config');
      if (!r.ok) return;
      const cfg = await r.json();
      const block = cfg && cfg.indicators;
      if (!block || typeof block !== 'object') return;
      IM.legendCollapsed = !!block.legend_collapsed;
      const list = Array.isArray(block.active) ? block.active : [];
      for (const saved of list) {
        const entry = IM.registry[saved.type];
        if (!entry) continue;
        // Re-instantiate via the type's add() rather than calling addIndicator
        // (which would generate a new id; we want to keep the persisted id).
        // The id must be known BEFORE add() so multi-instance-aware indicators
        // can key their KLineChart indicator by it (see addIndicator above).
        const instId = saved.id || _newInstanceId(saved.type);
        const klineId = entry.add(IM.chart, saved.params || entry.defaultParams, instId);
        const inst = {
          id:       instId,
          type:     saved.type,
          params:   { ...entry.defaultParams, ...(saved.params || {}) },
          visible:  saved.visible !== false,
          kline_id: klineId,
        };
        // If the persisted state was "hidden", push that to the chart now —
        // add() creates the indicator visible by default; we flush the full
        // instance state via applyParams to honour the saved hidden flag.
        if (!inst.visible) _flushToChart(inst);
        IM.active.push(inst);
      }
      _renderLegend();
    } catch (e) {
      console.warn('[IndicatorManager] load from config failed:', e);
    }
  }

  // ---------- Boot ----------

  async function init(chart) {
    if (IM._wired) return;
    IM._wired = true;
    IM.chart = chart;

    // Register known indicator types. As Phase 2+ ships, append more here.
    if (window.SwingPivotIndicator)       registerType(window.SwingPivotIndicator);
    if (window.NWaveIndicator)            registerType(window.NWaveIndicator);
    if (window.MicroPivotNWaveIndicator)  registerType(window.MicroPivotNWaveIndicator);
    if (window.BOSChoChDetector)          registerType(window.BOSChoChDetector);
    if (window.SupplyDemandZones)         registerType(window.SupplyDemandZones);
    if (window.SpanStructure)             registerType(window.SpanStructure);
    if (window.BreakMarker)               registerType(window.BreakMarker);

    // Restore active list from config.
    await _loadFromConfig();
  }

  // Indicator library — when the toolbar "Indicators" button fires.
  // Library UI itself lives in indicator_library.js (separate module);
  // this just exposes a hook so the library can call back to add.
  function getRegistry() {
    return { ...IM.registry };
  }
  function getActive() {
    return IM.active.slice();
  }

  window.IndicatorManager = {
    init,
    registerType,
    addIndicator,
    removeIndicator,
    setVisibility,
    openSettings,
    toggleCollapse,
    getRegistry,
    getActive,
  };
})();
