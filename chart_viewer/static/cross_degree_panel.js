/* ============================================================================
 * cross_degree_panel.js — UI inspector for the Phase 4b cross-degree snapshot
 * ============================================================================
 * Right-side panel that, on demand, computes CrossDegree.getAiSnapshot() at the
 * current cursor (replay cursor if active, else the latest closed bar) and
 * renders it so the user can eyeball-verify the multi-degree detection + nesting
 * against the chart. Read-only / verification tool — not part of the engine.
 * ========================================================================== */

(function () {
  const P = { el: null, bodyEl: null, btn: null, open: false, loading: false };

  // Detect via break_marker (Wister Span) so this inspector shows the SAME
  // structure the chart draws (visible break_marker indicator) — instead of
  // the old bos_choch path, which disagreed with it.
  // break_marker uses RAW swing pivots (no amplitude filter); density is
  // controlled by skip_sealed, NOT min_swing (see chart-viewer-gotchas), so the
  // per-degree min_swing knobs no longer apply here.
  const PARAMS = {
    degrees: ['1', '5', '15', '30'],
    structure_source: 'break_marker',
    skip_sealed: true,
    bm_add_span: false,
    span_ratio_lo: 0.5,
    span_ratio_hi: 2.0,
    min_break_gap: 2,
  };

  function init() {
    P.el = document.getElementById('cross-degree-panel');
    if (!P.el) return;
    P.bodyEl = P.el.querySelector('.cd-body');
    P.btn = document.getElementById('btn-cross-degree');
    if (P.btn) P.btn.addEventListener('click', toggle);
    const closeBtn = P.el.querySelector('.cd-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const refreshBtn = P.el.querySelector('.cd-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refresh);
    P.overlayToggle = document.getElementById('cd-overlay-toggle');
    if (P.overlayToggle) P.overlayToggle.addEventListener('change', _applyOverlay);
    // Symbol change invalidates the multi-TF cache.
    window.addEventListener('app:symbolChanged', () => { P.cache = null; P.lastCursorTs = null; });
  }

  // Push the last snapshot to the on-chart overlay (or hide it) per the toggle.
  function _applyOverlay() {
    const chart = window.App && window.App.chart;
    if (!chart || !window.CrossDegreeOverlay) return;
    if (P.overlayToggle && P.overlayToggle.checked && P.lastSnap) {
      window.CrossDegreeOverlay.show(chart, P.lastSnap, (window.App && window.App.currentTF) || '5');
    } else {
      window.CrossDegreeOverlay.hide(chart);
    }
    _syncLive();
  }

  // ---- Live (replay) updating ----------------------------------------------
  // During replay the snapshot recomputes on every cursor change. We do NOT
  // re-fetch per tick (4 HTTP calls would be far too slow): fetch the multi-TF
  // bars ONCE into a cache, then run the pure CrossDegree.buildSnapshot at the
  // new cursor. A rAF poll on Replay.cursorTimestamp catches every cursor
  // change (forward / step-back / pick) without hooking each replay path.
  function _liveActive() {
    return !!(P.open || (P.overlayToggle && P.overlayToggle.checked));
  }

  function _cacheCovers(symbol, asof) {
    return P.cache && P.cache.symbol === symbol &&
      Number.isFinite(asof) && asof >= P.cache.fromTs && asof <= P.cache.toTs;
  }

  async function _ensureCache(symbol, asof) {
    if (_cacheCovers(symbol, asof)) return P.cache;
    if (P.cacheLoading) return null;
    P.cacheLoading = true;
    try {
      const R = window.Replay;
      const endTs = (R && R.active && R.baseBars && R.baseBars.length)
        ? R.baseBars[R.baseBars.length - 1].timestamp + 1 : (asof + 1);
      const barsByTf = {};
      await Promise.all(PARAMS.degrees.map(async (tf) => {
        const q = new URLSearchParams({ symbol, tf, before: String(endTs), limit: '3000' });
        try { barsByTf[tf] = await (await fetch('/api/ohlcv?' + q.toString(), { cache: 'no-store' })).json(); }
        catch (e) { barsByTf[tf] = []; }
      }));
      // Coverage = the narrowest degree's span (the finest TF starts latest).
      let fromTs = -Infinity, toTs = Infinity;
      for (const tf of PARAMS.degrees) {
        const b = barsByTf[tf];
        if (b && b.length) { fromTs = Math.max(fromTs, b[0].timestamp); toTs = Math.min(toTs, b[b.length - 1].timestamp); }
      }
      P.cache = { symbol, barsByTf, fromTs, toTs };
    } finally {
      P.cacheLoading = false;
    }
    return _cacheCovers(symbol, asof) ? P.cache : null;
  }

  function _recomputeFromCache(asof, symbol) {
    if (!P.cache || !window.CrossDegree) return;
    const snap = window.CrossDegree.buildSnapshot(P.cache.barsByTf, asof, PARAMS);
    P.lastSnap = snap;
    P.lastCursorTs = asof;
    if (P.overlayToggle && P.overlayToggle.checked && window.CrossDegreeOverlay) {
      window.CrossDegreeOverlay.show(window.App.chart, snap, (window.App && window.App.currentTF) || '5');
    }
    if (P.open) _render(snap, symbol);
  }

  function _syncLive() {
    if (_liveActive() && !P.liveRAF) {
      const loop = () => {
        if (!_liveActive()) { P.liveRAF = null; return; }
        const R = window.Replay;
        const symbol = window.App && window.App.currentSymbol;
        if (R && R.active && symbol && Number.isFinite(R.cursorTimestamp) && R.cursorTimestamp !== P.lastCursorTs) {
          if (_cacheCovers(symbol, R.cursorTimestamp)) {
            _recomputeFromCache(R.cursorTimestamp, symbol);
          } else if (!P.cacheLoading) {
            _ensureCache(symbol, R.cursorTimestamp).then(() => { P.lastCursorTs = null; });
          }
        }
        P.liveRAF = requestAnimationFrame(loop);
      };
      P.liveRAF = requestAnimationFrame(loop);
    } else if (!_liveActive() && P.liveRAF) {
      cancelAnimationFrame(P.liveRAF);
      P.liveRAF = null;
    }
  }

  function toggle() { P.open ? close() : open(); }

  function open() {
    if (!P.el) return;
    P.open = true;
    P.el.classList.remove('hidden');
    if (P.btn) P.btn.classList.add('active');
    refresh();
  }

  function close() {
    if (!P.el) return;
    P.open = false;
    P.el.classList.add('hidden');
    if (P.btn) P.btn.classList.remove('active');
    _syncLive();   // stop the live loop if the overlay is also off
  }

  function _asof() {
    const R = window.Replay;
    if (R && R.active && R.cursorTimestamp != null) return R.cursorTimestamp;
    const bars = (window.App && window.App.currentBars) || [];
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i] && !bars[i]._placeholder) return bars[i].timestamp;
    }
    return null;
  }

  function _fmt(ts) {
    if (!Number.isFinite(ts)) return '—';
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/New_York', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(ts));
    } catch (e) { return String(ts); }
  }

  function _esc(s) { return String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

  async function refresh() {
    if (!window.CrossDegree || !P.bodyEl) {
      if (P.bodyEl) P.bodyEl.innerHTML = '<div class="cd-empty">CrossDegree 模組未載入</div>';
      return;
    }
    const symbol = window.App && window.App.currentSymbol;
    const asof = _asof();
    if (!symbol || !Number.isFinite(asof)) {
      P.bodyEl.innerHTML = '<div class="cd-empty">無資料（先載入圖表）</div>';
      return;
    }

    const R = window.Replay;
    if (R && R.active) {
      // Live path: cache the multi-TF bars once, then pure buildSnapshot at the
      // cursor. The rAF poll (_syncLive) keeps it updating on every tick.
      if (P.open) P.bodyEl.innerHTML = '<div class="cd-empty">抓取多週期資料…</div>';
      const c = await _ensureCache(symbol, asof);
      if (c) { P.lastCursorTs = null; _recomputeFromCache(asof, symbol); }
      else if (P.open) P.bodyEl.innerHTML = '<div class="cd-empty">無法覆蓋此 cursor 範圍</div>';
      _syncLive();
      return;
    }

    // Non-replay path: fetch a fresh snapshot at the latest closed bar.
    P.loading = true;
    P.bodyEl.innerHTML = '<div class="cd-empty">運算中…（抓取 1/5/15/30min 多週期資料）</div>';
    let snap;
    try {
      snap = await window.CrossDegree.getAiSnapshot(asof, { symbol, limit: 1500, params: PARAMS });
    } catch (e) {
      P.bodyEl.innerHTML = '<div class="cd-empty">錯誤：' + _esc((e && e.message) || e) + '</div>';
      P.loading = false;
      return;
    }
    P.loading = false;
    P.lastSnap = snap;
    _applyOverlay();       // refresh the on-chart overlay if its toggle is on
    if (!P.open) return;   // user closed it mid-fetch
    _render(snap, symbol);
  }

  function _render(snap, symbol) {
    const h = [];
    h.push(`<div class="cd-asof">${_esc(symbol)} · asof ${_fmt(snap.asof)} ET</div>`);

    // Reversal / force-zone candidates first (the actionable signal).
    if (snap.reversalZones && snap.reversalZones.length) {
      h.push('<div class="cd-section cd-rev"><div class="cd-sec-title">⚡ 翻轉區/發力區候選</div>');
      for (const rz of snap.reversalZones) {
        h.push(`<div class="cd-row">${_esc(rz.childTf)}m ${rz.chochRun.length}×CHoCh ${rz.direction === 'up' ? '↑' : '↓'}`
          + ` (${rz.side}) 對 ${_esc(rz.parent.tf)}m ${_esc(rz.parent.side)} 區(untested)</div>`);
      }
      h.push('</div>');
    }

    // Per degree, small → large.
    for (const d of snap.degrees) {
      const tr = d.trend === 'up' ? '▲' : d.trend === 'down' ? '▼' : '·';
      h.push(`<div class="cd-section"><div class="cd-sec-title">`
        + `${_esc(d.tf)}m <span class="cd-trend cd-${_esc(d.trend)}">${tr}</span>`
        + ` · ${d.events.length} 事件 / ${d.zones.length} 區</div>`);
      for (const e of d.events.slice(-6)) {
        h.push(`<div class="cd-row cd-ev cd-${_esc(e.direction)}">`
          + `<span class="cd-ts">${_fmt(e.eventTs)}</span> ${_esc(e.type)} `
          + `${e.direction === 'up' ? '↑' : '↓'} @${Math.round(e.level)}</div>`);
      }
      for (const z of d.zones.slice(-4)) {
        h.push(`<div class="cd-row cd-zone cd-${_esc(z.side)}">`
          + `<span class="cd-ts">${_fmt(z.eventTs)}</span> ${_esc(z.side)} `
          + `[${Math.round(z.lower)}–${Math.round(z.upper)}] <span class="cd-status">${_esc(z.status)}</span></div>`);
      }
      h.push('</div>');
    }

    // Nesting summary (counts by relation type).
    const byRel = {};
    for (const r of (snap.nesting || [])) byRel[r.relation] = (byRel[r.relation] || 0) + 1;
    h.push('<div class="cd-section"><div class="cd-sec-title">嵌套關係（小→大）</div>');
    const order = ['inside_zone', 'aligned', 'above_untested', 'below_untested'];
    let any = false;
    for (const k of order) if (byRel[k]) { h.push(`<div class="cd-row cd-nest">${k}: ${byRel[k]}</div>`); any = true; }
    if (!any) h.push('<div class="cd-row cd-nest">（無）</div>');
    h.push('</div>');

    P.bodyEl.innerHTML = h.join('');
  }

  function _ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  _ready(init);

  window.CrossDegreePanel = { init, open, close, toggle, refresh, isOpen: () => P.open };
})();
