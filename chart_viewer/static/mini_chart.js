/**
 * mini_chart.js — branching-replay-spec §5.4 mini chart.
 *
 * A compact KLineChart instance that lives below the main chart. Used
 * to visually compare two branches side-by-side (top/bottom) — the
 * main chart shows `BranchEngine.activeBranchId`, the mini shows
 * `BranchEngine.miniBranchId`. Same K-bar data; the difference is in
 * the trade markers (Phase 4b will render branch-specific arrows /
 * fork-line marker on the mini).
 *
 * Phase 4a (this file's initial scope):
 *   - Lazy-init KLineChart instance on first show
 *   - Show / hide via `miniBranchChanged` event
 *   - Header shows pill + name + meta + PnL + ✕
 *   - Same OHLC data as main (read-only)
 *   - Main chart resizes when mini opens / closes (chart-area flex
 *     shrinks → KLineChart.resize call deferred one rAF tick)
 *
 * Phase 4b (deferred):
 *   - X-axis viewport sync (when user pans / zooms main, mini
 *     follows)
 *   - Vertical fork-bar marker (purple #7d6cbf, 60% alpha)
 *   - Branch-specific trade arrows + open-position markers
 *
 * Read-only: no drawing tools, no order placement, no overlays.
 */
(function () {
  const MiniChart = {
    el: null,
    chart: null,            // klinecharts instance, null until first show
    initialized: false,     // DOM listeners wired (independent from chart instance)
    _mainOffsetRight: null, // mirror of main chart's setOffsetRightDistance
    _syncWired: false,      // subscribeAction listeners attached
    _syncing: false,        // re-entry guard for bidirectional viewport sync

    init() {
      this.el = document.getElementById('mini-chart-panel');
      if (!this.el) return;

      // Spec i18n §4.3: re-render the header label + fork-tooltip on
      // language change. _refreshHeader rebuilds both. Also flips the
      // KLineChart instance's built-in locale when the chart is alive.
      // Idempotent guard prevents listener stacking.
      if (!MiniChart._i18nWired) {
        MiniChart._i18nWired = true;
        document.addEventListener('i18n:change', () => {
          try { this._refreshHeader(); } catch (e) {}
          if (this.chart) {
            const code = (window.I18n && window.I18n.lang === 'en')
              ? 'en-US' : 'zh-CN';
            try { this.chart.setLocale(code); } catch (e) {}
          }
        });
      }

      const closeBtn = this.el.querySelector('.mini-close');
      if (closeBtn) closeBtn.addEventListener('click', () => {
        if (window.BranchEngine && window.BranchEngine.setMiniBranch) {
          window.BranchEngine.setMiniBranch(null);
        }
      });

      // Vertical resize handle — drag the thin strip at the top of the
      // panel to grow / shrink the mini chart. Inline `height` style
      // overrides the CSS default; clamped to [120, viewport*0.6].
      const resizer = this.el.querySelector('.mini-chart-resize');
      if (resizer) this._installResizeHandle(resizer);

      // Subscribe to BranchEngine events that affect mini visibility / header.
      const Eng = window.BranchEngine;
      if (Eng && Eng.on) {
        Eng.on('miniBranchChanged', () => this._sync());
        // Header reads name + kind + PnL — refresh on rename / kind
        // changes / new trade fills.
        Eng.on('branchRenamed', ({ id }) => {
          if (id === Eng.miniBranchId) this._refreshHeader();
        });
        Eng.on('branchUpdated', ({ id }) => {
          if (id === Eng.miniBranchId) this._refreshHeader();
        });
        Eng.on('branchDeleted', () => this._sync());
      }

      // Wrap App.chart.setOffsetRightDistance so any change made by
      // replay.js (or anywhere else) propagates to the mini chart.
      // KLineChart v9.8.10 has no public getter, so we mirror the
      // setter and remember the last-set value here. Mini may not
      // exist yet at this point — that's fine: applyMainOffsetRight
      // tracks the value and pushes it to mini once it's lazy-init'd.
      this._wrapMainOffsetRight();

      this.initialized = true;
      // Initial sync — covers the case where a previous session left
      // miniBranchId set in localStorage.
      this._sync();
    },

    _wrapMainOffsetRight() {
      const main = window.App && window.App.chart;
      if (!main || typeof main.setOffsetRightDistance !== 'function') return;
      if (main.__miniOffsetWrapped) return;
      const orig = main.setOffsetRightDistance.bind(main);
      const self = this;
      main.setOffsetRightDistance = function (px) {
        const r = orig(px);
        try { self.applyMainOffsetRight(px); } catch (e) {}
        return r;
      };
      main.__miniOffsetWrapped = true;
    },

    /** Reflect engine state. Show panel + apply data when miniBranchId
     *  is set; hide when null. Called on every miniBranchChanged. */
    _sync() {
      if (!this.el) return;
      const Eng = window.BranchEngine;
      const id = Eng && Eng.miniBranchId;
      const branch = id && Eng.getBranch ? Eng.getBranch(id) : null;
      if (!branch) {
        this._hide();
        return;
      }
      this._show(branch);
    },

    _show(branch) {
      if (!this.el) return;
      const wasHidden = this.el.hidden;
      this.el.hidden = false;
      this._refreshHeader(branch);
      this._ensureChart();
      this._applyData();
      this._startSyncLoop();   // X-axis poll + forkbar position
      if (wasHidden) {
        this._resizeMainChart();   // chart-area shrunk; main needs to redraw
      }
      // Trigger sim_overlays so the mini's trade arrows + duration
      // lines paint on the very first show. Without this they only
      // appear after the next mutation that itself triggers a sync.
      if (window.SimOverlays && window.SimOverlays.sync) {
        window.SimOverlays.sync();
      }
      // If the trade-history drawer is currently open, opening mini
      // forces a re-layout into 1/3-each vertical thirds (main /
      // mini / drawer). Without this hook the mini would land at
      // its 200px CSS default and squeeze the main chart.
      if (window.SimHistory && window.SimHistory.onMiniVisibilityChanged) {
        window.SimHistory.onMiniVisibilityChanged();
      }
    },

    _hide() {
      if (!this.el || this.el.hidden) return;
      this.el.hidden = true;
      this._stopSyncLoop();
      this._resizeMainChart();
      // Drop the mini-chart's overlays so a stale arrow doesn't
      // briefly flash on the next show before sync runs.
      if (window.SimOverlays && window.SimOverlays.sync) {
        window.SimOverlays.sync();
      }
      // Mirror of _show: if drawer is open and mini disappears, let
      // the drawer reset to its CSS default height (~38vh) so the
      // main chart picks up the freed space instead of staying
      // pinned to its previous 1/3-thirds size.
      if (window.SimHistory && window.SimHistory.onMiniVisibilityChanged) {
        window.SimHistory.onMiniVisibilityChanged();
      }
    },

    /** Lazy-init the KLineChart instance on first show. Cheaper boot
     *  for users who never use the mini. Same styling as main but
     *  smaller default text + tighter axis padding. */
    _ensureChart() {
      if (this.chart) return;
      if (typeof klinecharts === 'undefined' || !klinecharts.init) return;
      // Locale tracks I18n.lang. zh-TW isn't built-in to KLineChart 9
      // — fall through to zh-CN (the lib's default Chinese pack)
      // since this only governs axis/crosshair labels we don't
      // override. The i18n:change listener (init() above) calls
      // setLocale on the live instance when the user toggles.
      const _miniLocale = (window.I18n && window.I18n.lang === 'en')
        ? 'en-US' : 'zh-CN';
      this.chart = klinecharts.init('mini-chart', {
        locale: _miniLocale,
        timezone: 'America/New_York',
        styles: {
          grid: {
            horizontal: { color: 'rgba(42,46,57,0.4)' },
            vertical:   { color: 'rgba(42,46,57,0.4)' },
          },
          candle: {
            // Inherit current chart-settings colors via setStyles in
            // a follow-up; for now use the fixed defaults so the mini
            // has a consistent look until that's wired.
            bar: {
              upColor: '#26a69a', downColor: '#ef5350',
              upBorderColor: '#26a69a', downBorderColor: '#ef5350',
              upWickColor: '#26a69a', downWickColor: '#ef5350',
              // Hide doji-bar wick + border so the replay
              // placeholders don't render as a visible row of `+`
              // crosses on the mini. Placeholders have
              // open===close===fillPrice but high/low stretched to
              // the recent real-bar range (PROGRESS.md §4g) — without
              // this override the wick paints all the way to those
              // high/low and looks like a forest of doji crosses.
              // Trade-off: real doji bars in the historical data also
              // lose their wick on the mini, but doji is rare in
              // tick-derived OHLC and the mini is a glance-pane
              // anyway. Main chart applies the same trick on
              // enterReplay (then restores on exit).
              noChangeWickColor:   'transparent',
              noChangeBorderColor: 'transparent',
            },
            // Light tooltip — show price + time on hover so the user
            // can read what's at the cursor (TradingView mini-pane
            // behaviour). Compact via 'follow_cross' rule so it
            // appears only when the crosshair is active.
            tooltip: { showRule: 'follow_cross' },
            priceMark: { last: { show: true, line: { show: true, style: 'dashed' } } },
          },
          xAxis: {
            axisLine: { color: '#363a45' },
            tickText: { color: '#787b86' },
          },
          yAxis: {
            axisLine: { color: '#363a45' },
            tickText: { color: '#787b86' },
            // Default font size so the price-label width matches the
            // main chart exactly. Earlier this was `size: 10` which
            // shrank the yAxis by a few pixels — same dataIndex then
            // landed at different X on each chart, breaking the
            // viewport-sync alignment AND the pick-mode dim mirror
            // (which reuses main's snappedX directly).
          },
          // Match main chart's volume bar tint (translucent so the
          // candles painted on top remain readable).
          indicator: {
            bars: [{
              upColor: 'rgba(38,166,154,0.5)',
              downColor: 'rgba(239,83,80,0.5)',
              noChangeColor: '#888',
            }],
          },
          // Same hidden separator pattern as main — VOL sub-pane
          // visually flush with the candle pane.
          separator: { size: 0, color: 'transparent', activeBackgroundColor: 'transparent' },
        },
      });
      // Volume in its own pane (independent y-axis), short height so
      // the K-bar area dominates. No MA lines.
      this.chart.createIndicator(
        { name: 'VOL', calcParams: [] },
        false,
        { id: 'pane_vol', height: 50, dragEnabled: false }
      );
      // Inherit any tracked main-chart offsetRight so brand-new mini
      // instances align before the next setter call from replay.js.
      if (Number.isFinite(this._mainOffsetRight)
          && this.chart.setOffsetRightDistance) {
        try { this.chart.setOffsetRightDistance(this._mainOffsetRight); } catch (e) {}
      }
      // Bidirectional viewport sync via klinecharts' official
      // subscribeAction API (onScroll / onZoom). See:
      // https://v9.klinecharts.com/en-US/guide/instance-api
      this._wireSync();
    },

    /** Bidirectional pan/zoom sync between main and mini using
     *  klinecharts' subscribeAction events (the official approach).
     *  - onScroll → mirror getVisibleRange().to via scrollToDataIndex
     *  - onZoom   → mirror getBarSpace via setBarSpace
     *  A single `_syncing` re-entry guard prevents the mirrored call
     *  from echoing back. KLineChart fires actions synchronously
     *  (chart_store.execute → callbacks.forEach), so the guard window
     *  is tight and reliable.
     *  Idempotent: subsequent calls no-op if already wired. */
    _wireSync() {
      if (this._syncWired) return;
      const main = window.App && window.App.chart;
      const mini = this.chart;
      if (!main || !mini || !main.subscribeAction || !mini.subscribeAction) return;

      // Scroll: mirror the per-event pixel DELTA via scrollByDistance.
      // KLineChart fires `onScroll` with `{distance}` after each pan
      // step (see chart_pkg `execute(OnScroll, {distance: o})`).
      // Using the delta avoids the `getVisibleRange().to` trap — `to`
      // gets clamped to `dataLength-1` once the user pans into the
      // replay placeholder area, so it never changes and `range`-
      // based sync silently stops working.
      const onScroll = (src, dst) => (data) => {
        if (this._syncing) return;
        const dist = data && Number(data.distance);
        if (!Number.isFinite(dist) || dist === 0) return;
        this._syncing = true;
        try { if (dst.scrollByDistance) dst.scrollByDistance(dist, 0); }
        catch (e) {}
        this._syncing = false;
      };

      // Zoom: mirror barSpace, then anchor dst's right edge to src's,
      // then do a final pixel-level fix-up.
      // Why three steps:
      //   1. setBarSpace — same K-bar width on both charts.
      //   2. scrollToDataIndex(realTo) — coarse right-edge alignment.
      //      Drifts up to 1 bar because realTo is `Math.round(...)`-d
      //      inside klinecharts; src's actual right edge could sit at
      //      realTo − 0.5 while dst lands on the integer.
      //   3. _alignByPixel — measure a reference bar's X on both
      //      charts via convertToPixel and shift dst by the
      //      difference using scrollByDistance. Cleans up the
      //      sub-bar drift that step 2 leaves behind.
      const onZoom = (src, dst) => () => {
        if (this._syncing) return;
        const _bs = (v) => typeof v === 'number' ? v : (v && v.bar) || 0;
        const sBar = _bs(src.getBarSpace && src.getBarSpace());
        const dBar = _bs(dst.getBarSpace && dst.getBarSpace());
        const barChanged = sBar > 0 && Math.abs(sBar - dBar) > 0.001;
        if (!barChanged) return;
        this._syncing = true;
        try {
          if (dst.setBarSpace) dst.setBarSpace(sBar);
          const r = src.getVisibleRange && src.getVisibleRange();
          const rightIdx = r && (Number.isFinite(r.realTo) ? r.realTo : r.to);
          if (Number.isFinite(rightIdx) && dst.scrollToDataIndex) {
            dst.scrollToDataIndex(rightIdx, 0);
          }
          this._alignByPixel(src, dst);
        } catch (e) {}
        this._syncing = false;
      };

      main.subscribeAction('onScroll', onScroll(main, mini));
      main.subscribeAction('onZoom',   onZoom(main, mini));
      mini.subscribeAction('onScroll', onScroll(mini, main));
      mini.subscribeAction('onZoom',   onZoom(mini, main));

      // Initial alignment: zoom (barSpace) + a single right-edge anchor
      // via scrollToDataIndex on the LATEST data bar so both charts
      // land on the same starting frame regardless of their default
      // viewports. After this point, deltas carry the rest.
      try {
        const _bs = (v) => typeof v === 'number' ? v : (v && v.bar) || 0;
        const sBar = _bs(main.getBarSpace && main.getBarSpace());
        if (sBar > 0 && mini.setBarSpace) mini.setBarSpace(sBar);
        const bars = (window.App && window.App.currentBars) || [];
        if (bars.length && mini.scrollToDataIndex) {
          mini.scrollToDataIndex(bars.length - 1, 0);
        }
      } catch (e) {}

      this._syncWired = true;
    },

    /** Final pixel-level alignment between src and dst.
     *  Picks a reference dataIndex from src's visible range, looks up
     *  its pixel X on both charts, and shifts dst by the difference
     *  via scrollByDistance. This catches the sub-bar drift that
     *  setBarSpace + scrollToDataIndex leaves behind (klinecharts
     *  rounds `realTo`, so step 2 above is only accurate to ±0.5
     *  bars). Caller is responsible for the `_syncing` guard. */
    _alignByPixel(src, dst) {
      try {
        const r = src.getVisibleRange && src.getVisibleRange();
        if (!r) return;
        // Reference bar: middle of src's visible range. Mid of the
        // viewport is less affected by rounding at the edges.
        const ref = Math.round((r.from + r.to) / 2);
        if (!Number.isFinite(ref)) return;
        const point = [{ dataIndex: ref, value: 0 }];
        const opts  = { paneId: 'candle_pane' };
        const sPx = src.convertToPixel && src.convertToPixel(point, opts);
        const dPx = dst.convertToPixel && dst.convertToPixel(point, opts);
        const sx = (Array.isArray(sPx) ? sPx[0] : sPx) || {};
        const dx = (Array.isArray(dPx) ? dPx[0] : dPx) || {};
        if (!Number.isFinite(sx.x) || !Number.isFinite(dx.x)) return;
        const diff = dx.x - sx.x;
        // klinecharts' scrollByDistance: positive = pan-right (data
        // shifts left, newer bars move toward the right edge);
        // negative = pan-left. If dst's reference bar is RIGHT of
        // src's (diff > 0), we need dst to scroll LEFT, i.e. negative
        // distance. Skip noise under 0.5 px.
        if (Math.abs(diff) < 0.5) return;
        if (dst.scrollByDistance) dst.scrollByDistance(-diff, 0);
      } catch (e) { /* fall through silently */ }
    },

    /** Force-align mini to main's current viewport + offsetRight.
     *  Called after `_applyData` (klinecharts' applyNewData can
     *  auto-scroll to defaults, knocking mini out of sync — branch
     *  switches especially) so the forkbar shows up immediately
     *  instead of requiring the user to wheel-zoom first. */
    _syncFromMain() {
      const main = window.App && window.App.chart;
      const mini = this.chart;
      if (!main || !mini) return;
      // Re-apply tracked offsetRight (applyNewData may have reset it).
      if (Number.isFinite(this._mainOffsetRight)
          && mini.setOffsetRightDistance) {
        try { mini.setOffsetRightDistance(this._mainOffsetRight); } catch (e) {}
      }
      // Match main's barSpace, then anchor mini's right edge to main's
      // right edge. After this snapshot, the per-event distance/zoom
      // mirror in `_wireSync` carries the rest — no more polling.
      this._syncing = true;
      try {
        const _bs = (v) => typeof v === 'number' ? v : (v && v.bar) || 0;
        const sBar = _bs(main.getBarSpace && main.getBarSpace());
        const dBar = _bs(mini.getBarSpace && mini.getBarSpace());
        if (sBar > 0 && Math.abs(sBar - dBar) > 0.001 && mini.setBarSpace) {
          mini.setBarSpace(sBar);
        }
        // realTo (unclamped right-edge index) tracks the visible right
        // edge even when it lies inside the placeholder area — `to`
        // gets clamped to `dataLength-1` and stops moving as the user
        // pans further right.
        const r = main.getVisibleRange && main.getVisibleRange();
        const rightIdx = r && (Number.isFinite(r.realTo) ? r.realTo : r.to);
        if (Number.isFinite(rightIdx) && mini.scrollToDataIndex) {
          mini.scrollToDataIndex(rightIdx, 0);
        }
        this._alignByPixel(main, mini);
      } catch (e) {}
      this._syncing = false;
    },

    /** Called by replay.js after every `chart.setOffsetRightDistance`
     *  on the main chart. We don't have a public getter in v9.8.10,
     *  so the main side pushes the value here and we mirror it onto
     *  the mini chart so bars within the data area align horizontally
     *  on both. Tracked even when mini is closed so a later open()
     *  picks up the right value. */
    applyMainOffsetRight(px) {
      if (!Number.isFinite(px)) return;
      this._mainOffsetRight = px;
      if (this.chart && this.chart.setOffsetRightDistance) {
        try { this.chart.setOffsetRightDistance(px); } catch (e) {}
      }
    },

    _applyData() {
      if (!this.chart) return;
      // Replay anti-spoiler (PROGRESS.md §4f): when replay is active,
      // mini MUST read Replay.displayBars (past + cursor + placeholder
      // for every future slot) instead of App.currentBars. Otherwise
      // the mini happily shows every real K-bar past the cursor and
      // leaks the future to the user — defeating the entire pick-mode
      // dim. Falls back to App.currentBars when replay is off.
      const replayActive = !!(window.Replay && window.Replay.active);
      const bars = (replayActive
                    && Array.isArray(window.Replay.displayBars)
                    && window.Replay.displayBars.length)
        ? window.Replay.displayBars
        : ((window.App && window.App.currentBars) || []);
      this.chart.applyNewData(bars, false);
      // klinecharts' applyNewData resets internal scroll state — re-sync
      // viewport + offsetRight from main so the user sees aligned bars
      // immediately. Without this, switching the mini between two
      // branches leaves the forkbar invisible until the user wheel-
      // zooms (because convertToPixel for the new forkBarTimestamp
      // returns an off-screen X against mini's reset viewport).
      this._syncFromMain();
    },

    _refreshHeader(branch) {
      if (!this.el) return;
      const Eng = window.BranchEngine;
      if (!branch && Eng && Eng.miniBranchId && Eng.getBranch) {
        branch = Eng.getBranch(Eng.miniBranchId);
      }
      if (!branch) return;
      const pill = this.el.querySelector('.mini-pill');
      const name = this.el.querySelector('.mini-name');
      const meta = this.el.querySelector('.mini-meta');
      const pnl  = this.el.querySelector('.mini-pnl');
      const kind = branch.kind || 'exec';
      if (pill) {
        pill.className = 'mini-pill kind-' + kind;
      }
      // Forkbar line + glyph inherit the branch's kind color so they
      // match the main-chart ⋎ marker for this branch (instead of a
      // hardcoded purple). CSS rules on `.mini-forkbar-line.kind-X`
      // override the default `--branch-sandbox`.
      const forkLine = this.el.querySelector('.mini-forkbar-line');
      if (forkLine) {
        const wasHidden = forkLine.hidden;
        forkLine.className = 'mini-forkbar-line kind-' + kind;
        forkLine.hidden = wasHidden;
      }
      // Spec i18n §3.5 + §4.4 — kind label flows through I18n.t;
      // "主線"/"Main" auto-default goes through displayBranchName so the
      // name field shows the localized form for that single branch
      // while user-renamed ones stay verbatim.
      const t_ = (key) => (window.I18n && window.I18n.t)
        ? window.I18n.t(key) : key;
      if (name) {
        const isAutoMain = branch.kind === 'main' && (branch.name === '主線' || branch.name === 'Main');
        name.textContent = isAutoMain ? t_('branch.kindMain') : (branch.name || '?');
      }
      if (meta) {
        const KIND_LABEL_KEYS = {
          main:      'branch.kindMain',
          exec:      'branch.kindExec',
          direction: 'branch.kindDirection',
          sandbox:   'branch.kindSandbox',
          archived:  'branch.kindArchived',
        };
        const kindLabel = KIND_LABEL_KEYS[branch.kind] ? t_(KIND_LABEL_KEYS[branch.kind]) : branch.kind;
        const tradeCount = (Eng && Eng.getOwnTrades)
          ? Eng.getOwnTrades(branch.id).length : 0;
        const lang = (window.I18n && window.I18n.lang) || 'zh';
        const tradesWord = lang === 'en' ? 'trades' : '筆';
        meta.textContent = `${kindLabel} · ${tradeCount}${lang === 'en' ? ' ' : ''}${tradesWord}`;
      }
      if (pnl && Eng && Eng.getNetPL) {
        const v = Eng.getNetPL(branch.id) || 0;
        const sign = v >= 0 ? '+' : '−';
        pnl.textContent = `${sign}$${Math.abs(v).toFixed(0)}`;
        pnl.className = 'mini-pnl ' + (v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero');
      }
    },

    /** Wire the top-of-panel drag strip. mousedown captures the
     *  starting cursor Y + panel height; mousemove writes a clamped
     *  inline `height`; mouseup releases. main chart resizes on
     *  every move so the user sees immediate feedback. */
    _installResizeHandle(handle) {
      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (!this.el || this.el.hidden) return;
        e.preventDefault();
        const startY = e.clientY;
        const startH = this.el.getBoundingClientRect().height;
        const minH = 120;
        const maxH = Math.max(minH + 40, window.innerHeight * 0.6);
        handle.classList.add('dragging');
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        const onMove = (ev) => {
          // Cursor moving UP (smaller clientY) → larger panel.
          const next = Math.max(minH, Math.min(maxH, startH + (startY - ev.clientY)));
          this.el.style.height = next + 'px';
          // rAF-defer chart resize so the layout has reflowed.
          if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
          this._resizeRaf = requestAnimationFrame(() => {
            try { if (this.chart) this.chart.resize(); } catch (e2) {}
            try { if (window.App && window.App.chart) window.App.chart.resize(); } catch (e2) {}
          });
        };
        const onUp = () => {
          handle.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('mouseup',   onUp,   true);
        };
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup',   onUp,   true);
      });
    },

    /** Per-frame loop that updates the forkbar vertical line's `left`
     *  based on convertToPixel(forkBarTimestamp). Viewport sync (pan
     *  / zoom) is event-driven via subscribeAction in _wireSync — no
     *  longer polled here. The forkbar position still needs rAF
     *  because chart pan animations can run for multiple frames after
     *  a single onScroll event, and we want the line glued to its
     *  bar throughout the animation. */
    _startSyncLoop() {
      if (this._syncRaf != null) return;
      const tick = () => {
        try {
          this._maybeRefreshData();
          this._positionForkbar();
        } catch (e) { /* ignore */ }
        this._syncRaf = requestAnimationFrame(tick);
      };
      this._syncRaf = requestAnimationFrame(tick);
    },

    /** Cheap per-frame dirty-check that keeps the mini's data array
     *  aligned with main's. Replay tick / step-back / cursor pick /
     *  TF switch / symbol switch all re-call `applyNewData` on the
     *  main chart through replay.js + app.js. We don't want to hook
     *  every one of those call sites, so we poll the source-of-truth
     *  arrays here and only call `_applyData` when something actually
     *  changed. The check is O(1): length + last-bar fingerprint +
     *  cursor-bar fingerprint (covers in-progress tick aggregation
     *  inside the same display-TF bar). */
    _maybeRefreshData() {
      if (!this.chart || !this.chart.getDataList) return;
      const replayActive = !!(window.Replay && window.Replay.active);
      const wantBars = (replayActive
                        && Array.isArray(window.Replay.displayBars)
                        && window.Replay.displayBars.length)
        ? window.Replay.displayBars
        : ((window.App && window.App.currentBars) || []);
      if (!wantBars.length) return;
      const have = this.chart.getDataList();
      if (!have) return;
      const hLen = have.length, wLen = wantBars.length;
      const hLast = have[hLen - 1], wLast = wantBars[wLen - 1];
      const lenOk = hLen === wLen;
      const tailOk = hLast && wLast
        && hLast.timestamp === wLast.timestamp
        && hLast.close === wLast.close;
      // Replay aggregates ticks INTO the cursor bar without changing
      // length — fingerprint that bar separately. Cheap (one array
      // read per side).
      const cIdx = replayActive ? window.Replay.cursorBarIdx : -1;
      let cursorOk = true;
      if (lenOk && Number.isFinite(cIdx) && cIdx >= 0
          && cIdx < hLen && cIdx < wLen) {
        const h = have[cIdx], w = wantBars[cIdx];
        cursorOk = h && w
          && h.close === w.close
          && h.high  === w.high
          && h.low   === w.low;
      }
      if (lenOk && tailOk && cursorOk) return;
      this._applyData();
    },
    _stopSyncLoop() {
      if (this._syncRaf != null) {
        cancelAnimationFrame(this._syncRaf);
        this._syncRaf = null;
      }
    },

    _positionForkbar() {
      const line = this.el && this.el.querySelector('.mini-forkbar-line');
      if (!line) return;
      const Eng = window.BranchEngine;
      const branch = Eng && Eng.miniBranchId && Eng.getBranch
        ? Eng.getBranch(Eng.miniBranchId) : null;
      if (!branch || !Number.isFinite(branch.forkBarTimestamp)) {
        line.hidden = true;
        return;
      }
      const mini = this.chart;
      if (!mini || !mini.convertToPixel) {
        line.hidden = true;
        return;
      }
      let pt = null;
      try {
        const out = mini.convertToPixel(
          [{ timestamp: branch.forkBarTimestamp, value: 0 }],
          { paneId: 'candle_pane' });
        pt = Array.isArray(out) ? out[0] : out;
      } catch (e) { line.hidden = true; return; }
      const x = pt && pt.x;
      const body = this.el.querySelector('#mini-chart');
      const w = body ? body.clientWidth : 0;
      if (!Number.isFinite(x) || w <= 0 || x < -1 || x > w + 1) {
        // Off-screen — hide so we don't paint a stray line at the edge.
        line.hidden = true;
        return;
      }
      line.hidden = false;
      line.style.left = x + 'px';
      // Native tooltip — make the meaning explicit. Users were
      // confusing this line with their entry position; spell out
      // that it's the divergence point, not a trade marker.
      const fmtFn = (typeof window.formatBarTime === 'function')
        ? window.formatBarTime : (ts) => new Date(ts).toLocaleString();
      const ts = fmtFn(branch.forkBarTimestamp);
      const parent = (Eng.getBranch && branch.parentId)
        ? Eng.getBranch(branch.parentId) : null;
      // Spec §4.4 — translate auto-default "主線", keep custom names.
      const t_ = (key) => (window.I18n && window.I18n.t)
        ? window.I18n.t(key) : key;
      const parentName = (!parent)
        ? t_('branch.kindMain')
        : (parent.kind === 'main' && (parent.name === '主線' || parent.name === 'Main')
            ? t_('branch.kindMain')
            : parent.name);
      const lang = (window.I18n && window.I18n.lang) || 'zh';
      // Tooltip body not in spec §3.5 — translate inline.
      line.title = lang === 'en'
        ? `Branch fork point: ${ts}\n` +
          `This branch forked off "${parentName}" at this bar.\n` +
          `Bars to the left are inherited from ${parentName};\n` +
          `bars to the right belong to this branch's own timeline.`
        : `分支起點：${ts}\n` +
          `這條分支從「${parentName}」在這根 K 棒分出。\n` +
          `左邊是繼承自 ${parentName} 的歷史；\n` +
          `右邊才是這個分支自己的時間線。`;
    },

    /** Public: re-apply main chart's current bars to the mini. Call
     *  this from app.js after `App.currentBars` changes (TF switch,
     *  symbol switch, lazy-load page-back). Cheap if mini is hidden. */
    refreshData() {
      if (!this.el || this.el.hidden) return;
      this._applyData();
    },

    /** Tell the main KLineChart to re-measure its container after
     *  flex layout reflowed (mini panel took / released vertical
     *  space). One rAF defer so the layout has settled.
     *  Also resize the mini chart itself for the same reason. */
    _resizeMainChart() {
      requestAnimationFrame(() => {
        try { if (window.App && window.App.chart) window.App.chart.resize(); } catch (e) {}
        try { if (this.chart) this.chart.resize(); } catch (e) {}
      });
    },
  };

  window.MiniChart = MiniChart;
})();
