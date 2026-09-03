/**
 * pane_manager.js — multi-timeframe pane layout
 *
 * Shows 3+ independent KLineChart instances side by side, each with its
 * own timeframe, so the user can watch several frequencies at once
 * during both live browsing and replay.
 *
 * Pane 0 is always the EXISTING #chart — all drawing tools, persistence
 * and sim overlays keep working on it exactly as before; extra panes
 * are their own chart instances with a mirrored copy of the main
 * chart's structure indicators (see _mirrorIndicators) and no order
 * ticket / manual drawing tools of their own yet.
 *
 * Replay sync (see onReplayStatusUpdate / onReplaySubTick): while
 * Replay is active, each pane whose own TF is >= the replay's current
 * sub-tick granularity (Replay.subTfMs) gets a proper LIVE forming bar,
 * updated on every sub-tick exactly like the main chart's — just via
 * the public applyNewData() instead of tick()'s private-KLineChart-API
 * in-place redraw (that optimization was judged too risky to replicate
 * per-pane; applyNewData is the same fallback tick() itself uses when
 * the private path is unavailable, so it's a proven-safe code path,
 * just not the fastest one — fine for a handful of panes).
 *
 * A pane whose TF is FINER than Replay.subTfMs can't be aggregated
 * accurately from the current tick stream (each sub-tick would already
 * span more than one of that pane's bars) — those panes fall back to
 * showing only FULLY COMPLETE bars up to the cursor, refreshed once
 * per status update rather than live per sub-tick; lagging the cursor
 * by up to one pane-TF period. Lower the replay toolbar's sub-tick TF
 * (next to the play controls) to bring such a pane fully live.
 * Never shows anything past the cursor either way (verified
 * anti-spoiler-safe — see _completeBarsUpTo).
 */
(function () {
  /** Filter `bars` (ascending, one TF) down to only bars whose FULL
   *  period has elapsed at-or-before `cursorTs`. Replay.cursorTimestamp
   *  (per replay.js's own convention) points at the NEXT unplayed
   *  sub-bar, so a bar is complete only once something AFTER it has
   *  started — the bar containing/after the cursor is always excluded,
   *  never partially shown. Pure, no side effects. */
  function _completeBarsUpTo(bars, cursorTs) {
    if (!Array.isArray(bars) || !bars.length || !Number.isFinite(cursorTs)) return [];
    let i = 0;
    while (i < bars.length && bars[i].timestamp < cursorTs) i++;
    if (i < bars.length && bars[i].timestamp === cursorTs) return bars.slice(0, i);
    return bars.slice(0, Math.max(0, i - 1));
  }

  /** Same binary search as replay.js's findDisplayBarStart, generalized
   *  to any bars array: largest bar.timestamp <= ts, i.e. "which bar
   *  (at `bars`'s own TF) does timestamp ts fall into". Used to bin an
   *  incoming sub-tick into a pane's own TF bucket during live replay
   *  aggregation (_aggregatePaneTick) — reuses REAL, already-correctly-
   *  resampled bar boundaries from the server rather than computing
   *  period boundaries by hand (which breaks for ET-aligned D/W/M TFs). */
  function _findBarStart(bars, ts) {
    if (!bars || !bars.length) return null;
    let lo = 0, hi = bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].timestamp > ts) hi = mid - 1;
      else lo = mid + 1;
    }
    return hi >= 0 ? bars[hi].timestamp : null;
  }


  const LAYOUT_SLOTS = { cols3: 3, mainstack: 3, quad: 4 };
  const DEFAULT_LAYOUT = 'cols3';
  // Full catalog offered in the "manage saved frequencies" popover,
  // grouped for readability. Same TF grammar as the main chart's
  // #tf-popup: bare digits = minutes, m/h/d/w suffix = month/hour/day/week.
  const TF_CATALOG_GROUPS = [
    { label: 'panes.tfGroupMinutes', tfs: ['1', '3', '5', '15', '30', '45'] },
    { label: 'panes.tfGroupHours', tfs: ['1h', '2h', '4h'] },
    { label: 'panes.tfGroupDaysUp', tfs: ['1d', '1w', '1m'] },
  ];
  // Quick-pick pills shown on EVERY pane's header — one shared, saved
  // set (not per-pane), edited via the ☰ manage popover. Values are
  // drawn from the catalog (so every default pill is also toggleable
  // there). Persisted in localStorage so the user's picks survive a
  // reload, same convention as this codebase's other saved-preset UI
  // (drawing.js's chart-settings template popover — see
  // loadChartSettings/saveChartSettings for the pattern this mirrors).
  const DEFAULT_SAVED_TFS = ['1', '5', '15', '1h', '1d'];
  const SAVED_TFS_STORAGE_KEY = 'chart_viewer_pane_saved_tfs_v1';

  function _loadSavedTfs() {
    try {
      const raw = localStorage.getItem(SAVED_TFS_STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.every((t) => typeof t === 'string')) return arr;
      }
    } catch (e) {}
    return DEFAULT_SAVED_TFS.slice();
  }
  function _persistSavedTfs() {
    try { localStorage.setItem(SAVED_TFS_STORAGE_KEY, JSON.stringify(SAVED_TFS)); } catch (e) {}
  }
  const SAVED_TFS = _loadSavedTfs(); // shared across every pane

  const PaneManager = {
    active: false,
    layout: DEFAULT_LAYOUT,
    panes: [],       // extra panes only; [{id, tf, chart, container}]
    _nextId: 1,
    _hoveredPaneId: null, // null = main chart (#chart) is under the cursor

    getHoveredPaneId() { return this._hoveredPaneId; },

    /** Outline whichever pane the TF popup is currently targeting, so
     *  it's unambiguous which pane's frequency is about to change.
     *  Called from app.js's tf-popup show/hide/commit. */
    highlightPane(paneId) {
      document.querySelectorAll('.pane-cell.tf-targeting').forEach((el) => el.classList.remove('tf-targeting'));
      if (paneId == null) return;
      const cell = document.querySelector(`.pane-cell[data-pane-id="${paneId}"]`);
      if (cell) cell.classList.add('tf-targeting');
    },

    init() {
      const toggleBtn = document.getElementById('btn-multipane');
      const exitBtn = document.getElementById('pane-exit-btn');
      const addBtn = document.getElementById('pane-add-btn');
      if (toggleBtn) toggleBtn.addEventListener('click', () => this.toggle());
      if (exitBtn) exitBtn.addEventListener('click', () => this.setActive(false));
      if (addBtn) addBtn.addEventListener('click', () => this.addPane());
      document.querySelectorAll('.pane-layout-opt').forEach((btn) => {
        btn.addEventListener('click', () => this.setLayout(btn.getAttribute('data-layout')));
      });
      this._updateLayoutButtons();
      // Every pane is a real KLineChart canvas — like the main chart
      // (app.js's own window resize listener) each needs an explicit
      // .resize() on window resize, not just at creation time.
      window.addEventListener('resize', () => this._resizeAll());
      // Hover-to-target: the main chart's digit-buffer TF popup
      // (app.js TfInput) targets whichever pane the mouse is over when
      // typing starts — no click needed, matching how the main chart
      // has always worked (just type digits). Hovering #chart itself
      // resets the target back to the main chart.
      const mainChartEl = document.getElementById('chart');
      if (mainChartEl) mainChartEl.addEventListener('mouseenter', () => { this._hoveredPaneId = null; });
    },

    /** Nudge every live chart instance (main + extra panes) to
     *  re-measure its container. KLineChart caches canvas dimensions
     *  at init/last-resize time and does not auto-follow CSS grid
     *  reflows (layout switch, add/remove pane, window resize) —
     *  same trap the mini-chart panel already works around. */
    _resizeAll() {
      requestAnimationFrame(() => {
        if (window.App && window.App.chart) { try { window.App.chart.resize(); } catch (e) {} }
        for (const p of this.panes) {
          if (p.chart) { try { p.chart.resize(); } catch (e) {} }
        }
        this._layoutResizeHandles();
        this._updateSimTicketOffset();
      });
    },

    /** The order-entry ticket UI (sim_panel.js's TP/SL drag-out
     *  buttons, ticket pills, pending-order tickets) is main-chart-only
     *  and positions itself with `right: Npx` against #chart-area's
     *  full width — correct only when #chart (pane 0) fills #chart-area
     *  alone. In multi-pane mode pane 0 is narrower than #chart-area
     *  (other panes sit to its right), so those elements would hug the
     *  MULTI-PANE AREA's right edge instead of pane 0's — floating over
     *  a different pane's chart, or off in blank space, rather than
     *  over the main chart where the drag actually operates.
     *
     *  Sets --sim-pane-offset (read by .sim-ticket / .sim-pending-ticket
     *  / .sim-rail-line / .sim-rail-dot's `right: calc(Npx + var(...))`
     *  in style.css) to the width of whatever sits to the right of pane
     *  0 inside #chart-area, and --sim-pane-top-offset (read by a
     *  translateY on the three ticket containers themselves) to how
     *  far #chart's top sits below #chart-area's top — nonzero only
     *  because #pane-layout-bar occupies a row above the pane grid
     *  while multi-pane mode is on. Both are 0 in single-pane mode, so
     *  every affected rule resolves to its original static value,
     *  unchanged from before multi-pane mode existed. */
    _updateSimTicketOffset() {
      const chartArea = document.getElementById('chart-area');
      const chartEl = document.getElementById('chart');
      if (!chartArea || !chartEl) return;
      let rightOffset = 0, topOffset = 0;
      if (this.active) {
        const car = chartArea.getBoundingClientRect();
        const cer = chartEl.getBoundingClientRect();
        rightOffset = Math.max(0, car.right - cer.right);
        topOffset = Math.max(0, cer.top - car.top);
      }
      chartArea.style.setProperty('--sim-pane-offset', `${rightOffset}px`);
      chartArea.style.setProperty('--sim-pane-top-offset', `${topOffset}px`);
    },

    toggle() { this.setActive(!this.active); },

    setActive(on) {
      if (this.active === on) return;
      this.active = on;
      this._closeTfManager();
      const area = document.getElementById('chart-area');
      const bar = document.getElementById('pane-layout-bar');
      const row = document.getElementById('pane-row');
      const toggleBtn = document.getElementById('btn-multipane');
      if (area) area.classList.toggle('multipane', on);
      if (bar) bar.hidden = !on;
      if (toggleBtn) toggleBtn.classList.toggle('active', on);

      if (on) {
        if (!this.panes.length) this._seedDefaultPanes();
        if (row) row.setAttribute('data-layout', this.layout);
        this._renderCells();
      } else if (row) {
        row.setAttribute('data-layout', 'single');
        this._disposeAllCharts();
      }
      this._resizeAll();
      this._autoAlignReplaySubTf();
    },

    /** Keep replay.js's sub-tick TF matched to whatever panes are open
     *  NOW, so a fill's recorded time stays precise for the finest one
     *  (see replay.js's _autoPickSubTf doc comment for the actual rule
     *  — this was the "1min pane shows the wrong K-bar because sub-tick
     *  was left coarser than it" bug class). Call after any pane
     *  mutation; no-ops instantly when replay isn't active. */
    _autoAlignReplaySubTf() {
      if (window.Replay && window.Replay.autoAlignSubTf) {
        try { window.Replay.autoAlignSubTf(); } catch (e) {}
      }
    },

    setLayout(name) {
      if (!LAYOUT_SLOTS[name] || this.layout === name) return;
      this.layout = name;
      this._updateLayoutButtons();
      const slots = LAYOUT_SLOTS[name] - 1; // extra-pane slots (pane 0 is #chart)
      if (this.panes.length > slots) {
        for (const p of this.panes.slice(slots)) this._disposePane(p);
        this.panes = this.panes.slice(0, slots);
      }
      const row = document.getElementById('pane-row');
      if (row) {
        row.setAttribute('data-layout', this.layout);
        // A different arrangement has a different track count/shape (3
        // column tracks for cols3 vs 2 for mainstack/quad, etc.) — a
        // leftover pixel-based override from dragging a divider in the
        // OLD arrangement would misapply. Reset to the CSS defaults
        // (equal fr shares) on every switch.
        row.style.gridTemplateColumns = '';
        row.style.gridTemplateRows = '';
      }
      if (this.active) this._renderCells();
    },

    addPane() {
      const slots = LAYOUT_SLOTS[this.layout] - 1;
      if (this.panes.length >= slots) return;
      const pool = SAVED_TFS.length ? SAVED_TFS : DEFAULT_SAVED_TFS; // pool can be emptied via the manage popover
      const used = new Set([window.App && window.App.currentTF, ...this.panes.map((p) => p.tf)]);
      const tf = pool.find((t) => !used.has(t)) || pool[this.panes.length % pool.length];
      this.panes.push({ id: this._nextId++, tf, chart: null, containerId: null });
      this._renderCells();
      this._autoAlignReplaySubTf();
    },

    removePane(id) {
      const idx = this.panes.findIndex((p) => p.id === id);
      if (idx === -1) return;
      const [p] = this.panes.splice(idx, 1);
      this._disposePane(p);
      this._renderCells();
      this._autoAlignReplaySubTf();
    },

    setPaneTf(id, tf) {
      const p = this.panes.find((x) => x.id === id);
      if (!p || p.tf === tf) return;
      p.tf = tf;
      this._loadPaneData(p);
      this._renderCells(); // refresh the TF button active state
      this._autoAlignReplaySubTf();
    },

    _seedDefaultPanes() {
      const pool = SAVED_TFS.length ? SAVED_TFS : DEFAULT_SAVED_TFS;
      const mainTf = (window.App && window.App.currentTF) || '15';
      const seeds = pool.filter((t) => t !== mainTf).slice(0, LAYOUT_SLOTS[this.layout] - 1);
      this.panes = seeds.map((tf) => ({ id: this._nextId++, tf, chart: null, containerId: null }));
    },

    _updateLayoutButtons() {
      document.querySelectorAll('.pane-layout-opt').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-layout') === this.layout);
      });
      const addBtn = document.getElementById('pane-add-btn');
      if (addBtn) addBtn.disabled = this.panes.length >= (LAYOUT_SLOTS[this.layout] - 1);
    },

    /** Rebuild #pane-row's extra-pane cells to match `panes` + current
     *  layout's slot count. Reuses existing chart instances/containers
     *  when a pane is merely repositioned by a layout switch — only
     *  creates/destroys DOM+chart for panes that were actually added
     *  or removed, so switching arrangement doesn't refetch data. */
    _renderCells() {
      const row = document.getElementById('pane-row');
      if (!row) return;
      // Every _renderCells() rebuilds pane-cell-head DOM from scratch,
      // orphaning any open manage-popover's anchor button. Close it here;
      // the checkbox handler explicitly reopens it right after calling
      // _renderCells so picking multiple TFs in a row doesn't feel like
      // the popover is closing on every click.
      this._closeTfManager();
      const slots = LAYOUT_SLOTS[this.layout] - 1;

      // Drop stale cell elements (panes removed, or slots shrunk).
      const wantIds = new Set(this.panes.slice(0, slots).map((p) => p.id));
      row.querySelectorAll('.pane-cell[data-pane-id]').forEach((el) => {
        const id = Number(el.getAttribute('data-pane-id'));
        if (!wantIds.has(id)) el.remove();
      });
      row.querySelectorAll('.pane-cell-empty').forEach((el) => el.remove());

      for (let i = 0; i < slots; i++) {
        const pane = this.panes[i];
        if (pane) {
          let cell = row.querySelector(`.pane-cell[data-pane-id="${pane.id}"]`);
          if (!cell) {
            cell = this._buildCell(pane);
            row.appendChild(cell);
          }
          this._refreshCellHead(cell, pane);
          if (!pane.chart) this._initPaneChart(pane, cell.querySelector('.pane-cell-body'));
        } else {
          const empty = document.createElement('div');
          empty.className = 'pane-cell-empty';
          empty.textContent = (window.I18n ? window.I18n.t('panes.emptySlot') : '+ 加入頻率面板');
          empty.addEventListener('click', () => this.addPane());
          row.appendChild(empty);
        }
      }
      this._updateLayoutButtons();
      this._resizeAll();
      this._layoutResizeHandles();
    },

    /** (Re)build the draggable divider handles between panes for the
     *  current layout. Purely a visual/interaction overlay — positioned
     *  via getBoundingClientRect() after the grid has laid out, NOT
     *  participating in the grid itself, so this never has to touch
     *  _renderCells()'s DOM-order/grid-placement logic. Cheap to rebuild
     *  from scratch on every call (a handful of small absolutely-
     *  positioned divs). No-op outside multi-pane mode. */
    _layoutResizeHandles() {
      const row = document.getElementById('pane-row');
      if (!row) return;
      row.querySelectorAll('.pane-resize-handle').forEach((el) => el.remove());
      if (!this.active || this.layout === 'single') return;

      const cells = Array.from(row.children).filter((el) =>
        el.id === 'chart' || el.classList.contains('pane-cell') || el.classList.contains('pane-cell-empty'));
      if (cells.length < 2) return;
      const rowRect = row.getBoundingClientRect();

      if (this.layout === 'cols3') {
        // N cells left-to-right — one vertical divider between each pair.
        for (let i = 0; i < cells.length - 1; i++) {
          this._addColHandle(row, rowRect, i, cells.length, cells[i].getBoundingClientRect(), cells[i + 1].getBoundingClientRect());
        }
      } else if (this.layout === 'mainstack') {
        // cells[0] = main (spans full height), cells[1]/[2] = stacked side cells.
        const r0 = cells[0].getBoundingClientRect();
        const r1 = cells[1].getBoundingClientRect();
        this._addColHandle(row, rowRect, 0, 2, r0, r1);
        if (cells.length >= 3) {
          const r2 = cells[2].getBoundingClientRect();
          // Only spans the side column's width, not the full row.
          this._addRowHandle(row, rowRect, 0, 2, r1, r2, r1.left - rowRect.left, r1.right - rowRect.left);
        }
      } else if (this.layout === 'quad') {
        // 2x2 auto-flow: cells[0]=TL, [1]=TR, [2]=BL, [3]=BR. Column
        // boundary x is the same for both rows (one grid-template-columns
        // for the whole grid); row boundary y is the same for both cols.
        const rTL = cells[0].getBoundingClientRect();
        const rTR = cells[1].getBoundingClientRect();
        this._addColHandle(row, rowRect, 0, 2, rTL, rTR);
        if (cells.length >= 3) {
          const rBL = cells[2].getBoundingClientRect();
          this._addRowHandle(row, rowRect, 0, 2, rTL, rBL, 0, rowRect.width);
        }
      }
    },

    /** Vertical divider between column `colIndex` and `colIndex+1` (of
     *  `totalCols`), spanning the full row height. Dragging adjusts
     *  those two tracks of pane-row's grid-template-columns in lockstep
     *  (grow one, shrink the other by the same amount), clamped so
     *  neither track drops below MIN_PANE_PX. */
    _addColHandle(row, rowRect, colIndex, totalCols, rectA, rectB) {
      const HIT_W = 10;
      const x = (rectA.right + rectB.left) / 2 - rowRect.left;
      const handle = document.createElement('div');
      handle.className = 'pane-resize-handle col';
      handle.style.left = `${x - HIT_W / 2}px`;
      handle.style.top = '0';
      handle.style.width = `${HIT_W}px`;
      handle.style.height = `${rowRect.height}px`;
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._dragTrack(row, 'gridTemplateColumns', colIndex, totalCols, e.clientX, (ev) => ev.clientX, handle);
      });
      row.appendChild(handle);
    },

    /** Horizontal divider between row `rowIndex` and `rowIndex+1` (of
     *  `totalRows`), spanning from `spanLeftPx` to `spanRightPx` (row-
     *  relative px — mainstack's divider only covers the side column,
     *  quad's covers the full width). */
    _addRowHandle(row, rowRect, rowIndex, totalRows, rectA, rectB, spanLeftPx, spanRightPx) {
      const HIT_H = 10;
      const y = (rectA.bottom + rectB.top) / 2 - rowRect.top;
      const handle = document.createElement('div');
      handle.className = 'pane-resize-handle row';
      handle.style.top = `${y - HIT_H / 2}px`;
      handle.style.left = `${spanLeftPx}px`;
      handle.style.height = `${HIT_H}px`;
      handle.style.width = `${spanRightPx - spanLeftPx}px`;
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._dragTrack(row, 'gridTemplateRows', rowIndex, totalRows, e.clientY, (ev) => ev.clientY, handle);
      });
      row.appendChild(handle);
    },

    /** Shared drag loop for both column and row dividers. Reads the
     *  CURRENT resolved track sizes via getComputedStyle (grid always
     *  reports resolved px there, whether the template came from the
     *  default CSS `fr` rule or a previous drag's inline px override —
     *  so this works identically on the very first drag and every one
     *  after), adjusts the two tracks adjacent to `trackIndex` by the
     *  mouse delta (clamped so neither goes below MIN_PANE_PX), and
     *  writes the full track list back as an explicit px string. */
    _dragTrack(row, cssProp, trackIndex, totalTracks, startPos, getPos, handleEl) {
      const MIN_PANE_PX = 120;
      const cs = getComputedStyle(row);
      const tracks = cs[cssProp].split(' ').map((v) => parseFloat(v));
      if (tracks.length !== totalTracks || tracks.some((v) => !Number.isFinite(v))) return;
      handleEl.classList.add('dragging');
      document.body.classList.add('pane-resizing');
      const prevCursor = document.body.style.cursor;
      document.body.style.cursor = cssProp === 'gridTemplateRows' ? 'row-resize' : 'col-resize';

      const onMove = (e) => {
        const delta = getPos(e) - startPos;
        const a0 = tracks[trackIndex], b0 = tracks[trackIndex + 1];
        const clamped = Math.max(MIN_PANE_PX - a0, Math.min(b0 - MIN_PANE_PX, delta));
        const next = tracks.slice();
        next[trackIndex] = a0 + clamped;
        next[trackIndex + 1] = b0 - clamped;
        row.style[cssProp] = next.map((v) => `${v}px`).join(' ');
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        handleEl.classList.remove('dragging');
        document.body.classList.remove('pane-resizing');
        document.body.style.cursor = prevCursor;
        this._resizeAll(); // KLineChart canvases need an explicit nudge — see _resizeAll's own comment
        this._layoutResizeHandles(); // handle positions follow the new track sizes
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },

    _buildCell(pane) {
      const cell = document.createElement('div');
      cell.className = 'pane-cell';
      cell.setAttribute('data-pane-id', String(pane.id));
      cell.addEventListener('mouseenter', () => { this._hoveredPaneId = pane.id; });
      const head = document.createElement('div');
      head.className = 'pane-cell-head';
      cell.appendChild(head);
      const body = document.createElement('div');
      body.className = 'pane-cell-body';
      const containerId = `pane-chart-${pane.id}`;
      body.id = containerId;
      pane.containerId = containerId;
      cell.appendChild(body);
      return cell;
    },

    _refreshCellHead(cell, pane) {
      const head = cell.querySelector('.pane-cell-head');
      if (!head) return;
      const fmt = (tf) => ((window.App && window.App.formatTfDisplay) ? window.App.formatTfDisplay(tf) : tf);

      // Current-TF button — always shows the pane's actual TF (even if
      // it's not one of the saved pills below) and is the entry point
      // into the SAME digit-buffer popup the main chart's own TF button
      // uses (app.js openTfPopupForPane/TfInput/tfCommit), so typing a
      // frequency here behaves identically to the main chart.
      const currentBtn = document.createElement('button');
      currentBtn.type = 'button';
      currentBtn.className = 'pane-tf-current';
      currentBtn.textContent = fmt(pane.tf);
      currentBtn.title = (window.I18n ? window.I18n.t('panes.currentTfTooltip') : '輸入頻率');
      currentBtn.addEventListener('click', () => {
        if (window.App && window.App.openTfPopupForPane) window.App.openTfPopupForPane(pane.id);
      });

      // Saved-frequency quick-pick pills — ONE shared, user-curated set
      // across every pane (manage popover below), one click to switch,
      // no popup needed.
      const tfSelect = document.createElement('div');
      tfSelect.className = 'pane-tf-select';
      for (const tf of SAVED_TFS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = fmt(tf);
        if (tf === pane.tf) btn.classList.add('active');
        btn.addEventListener('click', () => this.setPaneTf(pane.id, tf));
        tfSelect.appendChild(btn);
      }

      const manageBtn = document.createElement('button');
      manageBtn.type = 'button';
      manageBtn.className = 'pane-tf-manage';
      manageBtn.title = (window.I18n ? window.I18n.t('panes.manageTfTooltip') : '管理常用頻率');
      manageBtn.textContent = '☰';
      manageBtn.addEventListener('click', () => this._toggleTfManager(pane, manageBtn));

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'pane-cell-remove';
      removeBtn.textContent = '✕';
      removeBtn.title = (window.I18n ? window.I18n.t('panes.removePaneTooltip') : '移除面板');
      removeBtn.addEventListener('click', () => this.removePane(pane.id));

      head.innerHTML = '';
      head.appendChild(currentBtn);
      head.appendChild(tfSelect);
      head.appendChild(manageBtn);
      head.appendChild(removeBtn);
    },

    /** Popover (object-tree-style checklist) to edit which frequencies
     *  show up as a pane's quick-pick pills. Body-appended + fixed-
     *  positioned against the trigger button, same convention as this
     *  codebase's other floating popovers (e.g. .color-popover) so it
     *  isn't clipped by .pane-cell's overflow:hidden. */
    _closeTfManager() {
      const existing = document.getElementById('pane-tf-manager-popover');
      if (existing) existing.remove();
      if (this._tfManagerDismiss) {
        document.removeEventListener('mousedown', this._tfManagerDismiss, true);
        this._tfManagerDismiss = null;
      }
    },

    _toggleTfManager(pane, anchorEl) {
      const existing = document.getElementById('pane-tf-manager-popover');
      const wasForThisPane = existing && Number(existing.getAttribute('data-pane-id')) === pane.id;
      this._closeTfManager();
      if (wasForThisPane) return; // second click on the same pane's ☰ = close
      this._buildTfManager(pane, anchorEl);
    },

    _buildTfManager(pane, anchorEl) {
      const pop = document.createElement('div');
      pop.id = 'pane-tf-manager-popover';
      pop.className = 'pane-tf-manager-popover';
      pop.setAttribute('data-pane-id', String(pane.id));

      const title = document.createElement('div');
      title.className = 'pane-tf-manager-title';
      title.textContent = (window.I18n ? window.I18n.t('panes.manageTfTitle') : '常用頻率');
      pop.appendChild(title);

      for (const group of TF_CATALOG_GROUPS) {
        const label = document.createElement('div');
        label.className = 'obj-tree-group-label';
        label.textContent = (window.I18n ? window.I18n.t(group.label) : group.label);
        pop.appendChild(label);
        for (const tf of group.tfs) {
          const row = document.createElement('label');
          row.className = 'pane-tf-manager-row';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = SAVED_TFS.includes(tf);
          cb.addEventListener('change', () => {
            if (cb.checked) {
              if (!SAVED_TFS.includes(tf)) SAVED_TFS.push(tf);
            } else {
              const i = SAVED_TFS.indexOf(tf);
              if (i !== -1) SAVED_TFS.splice(i, 1);
            }
            _persistSavedTfs();
            this._renderCells();
            // _renderCells rebuilds the head (and this popover's anchor
            // button) from scratch — rebuild (not toggle) so the
            // checklist stays open across multiple picks instead of
            // closing after every click.
            this._closeTfManager();
            const cell = document.querySelector(`.pane-cell[data-pane-id="${pane.id}"]`);
            const btn = cell && cell.querySelector('.pane-tf-manage');
            if (btn) this._buildTfManager(pane, btn);
          });
          const span = document.createElement('span');
          span.textContent = (window.App && window.App.formatTfDisplay) ? window.App.formatTfDisplay(tf) : tf;
          row.appendChild(cb);
          row.appendChild(span);
          pop.appendChild(row);
        }
      }

      document.body.appendChild(pop);
      const r = anchorEl.getBoundingClientRect();
      const popW = pop.offsetWidth || 160;
      pop.style.top = `${r.bottom + 4}px`;
      pop.style.left = `${Math.min(r.left, window.innerWidth - popW - 8)}px`;

      this._tfManagerDismiss = (e) => {
        if (pop.contains(e.target) || e.target === anchorEl) return;
        this._closeTfManager();
      };
      document.addEventListener('mousedown', this._tfManagerDismiss, true);
    },

    _initPaneChart(pane, bodyEl) {
      if (!bodyEl || !window.App || !window.App.initChart) return;
      const chart = window.App.initChart(pane.containerId);
      pane.chart = chart;
      this._mirrorIndicators(pane);
      this._loadPaneData(pane);
    },

    /** One-time snapshot of the main chart's CURRENT structure-indicator
     *  set (break_marker / supply_demand_zones / bos_choch / span_structure
     *  / swing_pivot / n_wave — whatever's active via the topbar's
     *  Indicators library) onto a freshly created pane. Not live-synced:
     *  adding/removing/reconfiguring indicators on the main chart later
     *  doesn't retroactively touch already-open panes — toggling
     *  multi-pane mode off/on re-snapshots on the next open.
     *
     *  `__pane_instance: true` tells the indicator's calc() (bos_choch.js,
     *  supply_demand_zones.js, span_structure.js, break_marker.js) to skip
     *  writing into its module-level "results by paneId" cache — every
     *  chart instance defaults to the same KLineChart paneId, so a pane's
     *  own recalc would otherwise clobber the main chart's cached result
     *  out from under event_log.js's getEventsForChart/getZonesForChart. */
    _mirrorIndicators(pane) {
      if (!pane.chart || !window.IndicatorManager) return;
      const registry = window.IndicatorManager.getRegistry();
      const active = window.IndicatorManager.getActive();
      pane.indicators = [];
      for (const inst of active) {
        const entry = registry[inst.type];
        if (!entry || !entry.add) continue;
        try {
          const klineId = entry.add(pane.chart, { ...inst.params, __pane_instance: true }, inst.id);
          pane.indicators.push({ type: inst.type, klineId });
          if (inst.visible === false && entry.applyParams) {
            entry.applyParams(pane.chart, klineId, inst.params, false);
          }
        } catch (e) {
          console.warn('[pane_manager] failed to mirror indicator', inst.type, e);
        }
      }
    },

    async _loadPaneData(pane) {
      if (!pane.chart || !window.App || !window.App.fetchOHLCV) return;
      // Replay owns pane data once a cursor is picked — route there
      // instead (covers pane creation and TF switches that happen
      // mid-replay) so a plain live fetch never overwrites a
      // replay-synced pane with data that leaks past the cursor.
      // Replay.active alone isn't enough: entering replay shows a
      // "select start point" picker BEFORE any cursor exists, and the
      // main chart itself just shows the full live series during that
      // window (enterReplay's own initial applyNewData) — mirror that
      // here rather than routing to _syncPaneReplay, whose cursorTs
      // guard would leave a freshly (re)created pane blank until the
      // user finishes picking.
      const R = window.Replay;
      if (R && R.active && Number.isFinite(R.cursorTimestamp)) {
        pane._replayBaseBars = null; // TF changed → old window is for the wrong TF
        await this._syncPaneReplay(pane, R.cursorTimestamp);
        this._syncSimOverlays();
        return;
      }
      try {
        const bars = await window.App.fetchOHLCV(pane.tf, { limit: 1500 });
        // The pane may have been removed (or its TF changed again)
        // while this fetch was in flight — bail rather than apply
        // stale data to a live instance.
        if (!this.panes.includes(pane)) return;
        pane.chart.applyNewData(bars, false);
        this._syncSimOverlays();
      } catch (e) {
        console.warn('[pane_manager] failed to load pane data', pane.tf, e);
      }
    },

    /** Trade markers + TP/SL bands/lines (sim_overlays.js) react to
     *  engine state changes on their own, but a pane getting its FIRST
     *  batch of bars (creation, TF switch, replay reseed) isn't an
     *  engine change — nudge a sync so an already-open position's
     *  bands appear immediately instead of waiting for the next
     *  unrelated trade action. */
    _syncSimOverlays() {
      if (window.SimOverlays && window.SimOverlays.sync) {
        try { window.SimOverlays.sync(); } catch (e) {}
      }
    },

    // ---------- Replay sync ----------
    // See the module doc comment at the top of this file for the "live
    // forming bar when the pane's TF is >= the tick granularity, complete-
    // bars-only fallback otherwise" design.

    /** Called from replay.js's updateStatus() on every cursor-mutating
     *  path (tick, stepBack, TF-switch mid-replay, re-pick, enter/exit).
     *  Fire-and-forget from there; safe to call at any cadence. Owns
     *  seeding (_replayBaseBars) for every pane and the FULL display
     *  refresh for fallback-strategy panes; live-strategy panes are
     *  seeded here too but subsequently owned by onReplaySubTick. */
    onReplayStatusUpdate() {
      const R = window.Replay;
      if (!R) return;
      if (!R.active) {
        if (this._inReplay) {
          this._inReplay = false;
          for (const p of this.panes) {
            p._replayBaseBars = null;
            p._replayDisplayBars = null;
            this._loadPaneData(p); // back to independent live data
          }
        }
        return;
      }
      this._inReplay = true;
      if (!Number.isFinite(R.cursorTimestamp)) return; // no cursor picked yet
      for (const p of this.panes) this._syncPaneReplay(p, R.cursorTimestamp);
    },

    /** Called from replay.js's tick() with the sub-bar it just consumed
     *  (before that tick's updateStatus() call). Live-aggregates that
     *  tick into every pane whose own TF is >= Replay.subTfMs — the
     *  common case, and the one that gets a real per-tick forming bar.
     *  Panes finer than the tick stream are skipped here (see
     *  onReplayStatusUpdate's fallback path instead). No-ops on any
     *  pane not yet seeded (_replayBaseBars null) — the very next
     *  updateStatus() call seeds it; this one sub-tick is simply missed
     *  for a pane added mid-tick, self-corrects from the next tick on. */
    onReplaySubTick(sub) {
      const R = window.Replay;
      if (!R || !R.active || !sub) return;
      for (const pane of this.panes) {
        if (!pane.chart || !pane._replayBaseBars || !pane._replayBaseBars.length) continue;
        const paneTfMs = R.parseTfMs ? R.parseTfMs(pane.tf) : null;
        const isLive = Number.isFinite(paneTfMs) && Number.isFinite(R.subTfMs) && paneTfMs >= R.subTfMs;
        if (isLive) this._aggregatePaneTick(pane, sub);
      }
    },

    /** Mirrors replay.js tick()'s same-bar/new-bar aggregation (new bar:
     *  push a fresh one seeded from `sub`'s OHLC; same bar: extend
     *  high/low/close/volume), generalized to one pane's own TF via
     *  _findBarStart against that pane's REAL fetched bars (correct
     *  period boundaries without hand-rolled ET-alignment math). Renders
     *  through the public applyNewData — see the module doc comment for
     *  why that's the deliberate choice over tick()'s private-API path. */
    _aggregatePaneTick(pane, sub) {
      const bars = pane._replayDisplayBars;
      if (!bars) return;
      const dispStart = _findBarStart(pane._replayBaseBars, sub.timestamp);
      if (dispStart == null) return;
      const curBar = bars[bars.length - 1];
      const isNewBar = !curBar || curBar.timestamp !== dispStart;
      if (isNewBar) {
        bars.push({
          timestamp: dispStart,
          open: sub.open, high: sub.high, low: sub.low,
          close: sub.close, volume: sub.volume,
        });
      } else {
        curBar.high = Math.max(curBar.high, sub.high);
        curBar.low = Math.min(curBar.low, sub.low);
        curBar.close = sub.close;
        curBar.volume = (curBar.volume || 0) + sub.volume;
      }
      try { pane.chart.applyNewData(bars, false); } catch (e) {}
    },

    /** Ensure one pane's _replayBaseBars window covers `cursorTs`
     *  (re-fetching — the only network call in the replay-sync path —
     *  when it doesn't: replay start, a big rewind/re-pick, or a TF
     *  switch mid-replay), then either reset its display to a fresh
     *  "complete bars so far" snapshot (on a fresh seed, so the next
     *  sub-tick starts a clean forming bar) or, for fallback-strategy
     *  panes only, re-snapshot on every call since they have no
     *  incremental forming-bar state to preserve. Live-strategy panes
     *  with an already-covered window are left untouched here —
     *  onReplaySubTick owns their display exclusively past the seed.
     *  Re-entrancy-guarded per pane so overlapping ticks during play()
     *  don't stack fetches. */
    async _syncPaneReplay(pane, cursorTs) {
      if (!pane.chart || !Number.isFinite(cursorTs) || pane._replaySyncing) return;
      const R = window.Replay;
      const bb = pane._replayBaseBars;
      const covered = bb && bb.length && cursorTs >= bb[0].timestamp && cursorTs <= bb[bb.length - 1].timestamp;
      const paneTfMs = R.parseTfMs ? R.parseTfMs(pane.tf) : null;
      const isLive = Number.isFinite(paneTfMs) && Number.isFinite(R.subTfMs) && paneTfMs >= R.subTfMs;
      if (!covered) {
        pane._replaySyncing = true;
        try {
          const limit = 2000;
          const tfMsForWindow = paneTfMs || 60000;
          // Anchor the fetch window's END ~half its length AHEAD of the
          // cursor (in pane-TF units) so the cursor sits mid-window —
          // gives headroom before the next re-fetch is needed as the
          // cursor keeps advancing. `end` is date-granularity server-side
          // (data_service.get_ohlcv does `df.index <= pd.Timestamp(end)`,
          // which is MIDNIGHT UTC of that date — i.e. the START of the
          // day, not the end). Truncating endTs straight to a date string
          // can therefore land BEFORE endTs's own time-of-day, and in the
          // worst case even before cursorTs itself. +1 day guarantees
          // midnight of the resulting date is always >= endTs (midnight
          // of any day plus 24h exceeds any time-of-day within that day).
          const endTs = cursorTs + Math.round(limit / 2) * tfMsForWindow;
          const endDate = new Date(endTs + 24 * 3600 * 1000).toISOString().slice(0, 10);
          const bars = await window.App.fetchOHLCV(pane.tf, { end: endDate, limit });
          if (!this.panes.includes(pane)) return; // pane removed mid-fetch
          pane._replayBaseBars = bars;
          // Fresh window → reset the forming-bar state so the next
          // sub-tick starts clean rather than extending a bar built
          // against the OLD (now-discarded) baseBars reference.
          pane._replayDisplayBars = _completeBarsUpTo(bars, cursorTs);
          try { pane.chart.applyNewData(pane._replayDisplayBars, false); } catch (e) {}
          this._syncSimOverlays();
        } catch (e) {
          console.warn('[pane_manager] replay seed fetch failed', pane.tf, e);
        } finally {
          pane._replaySyncing = false;
        }
        return;
      }
      if (!isLive) {
        pane._replayDisplayBars = _completeBarsUpTo(pane._replayBaseBars, cursorTs);
        try { pane.chart.applyNewData(pane._replayDisplayBars, false); } catch (e) {}
        // Re-sync AFTER this pane's own bars just advanced. SimController.
        // onReplayTick() already calls SimOverlays.sync() unconditionally
        // on every tick (sim_panel.js) — but that fires BEFORE this
        // function runs (replay.js's tick() → onReplayTick() happens,
        // THEN later updateStatus() → onReplayStatusUpdate() → here). For
        // a pane finer than Replay.subTfMs (not "live", no per-subtick
        // aggregation — see this file's module doc comment), that earlier
        // sync() read this pane's stale, one-tick-behind dataList: a fill
        // landing in the bar that only got appended just now would have
        // resolved to whatever bar WAS last present, i.e. an EARLIER bar
        // than the real one, and nothing re-evaluates it afterward — the
        // exact "1-min pane's exit triangle sits on 06:00 instead of the
        // real 06:11" symptom. Sync again now that the bar is actually here.
        this._syncSimOverlays();
      }
      // Live + already covered: nothing to do — onReplaySubTick owns it.
    },

    _disposePane(pane) {
      if (pane.chart && pane.containerId && window.klinecharts && window.klinecharts.dispose) {
        try { window.klinecharts.dispose(pane.containerId); } catch (e) {}
      }
      pane.chart = null;
      // Drop this pane's sim-overlay id maps (TP/SL bands, entry/BE
      // lines, trade arrows, duration line) — the chart instance they
      // pointed into is already gone, so leaving them would let a
      // future pane id collision (unlikely, _nextId only grows, but
      // cheap to guard) or a stale sync() pass reference dead overlays.
      if (window.SimOverlays && window.SimOverlays.dropPaneMaps) {
        window.SimOverlays.dropPaneMaps(pane.id);
      }
      const row = document.getElementById('pane-row');
      const cell = row && row.querySelector(`.pane-cell[data-pane-id="${pane.id}"]`);
      if (cell) cell.remove();
    },

    _disposeAllCharts() {
      for (const p of this.panes) {
        if (p.chart && p.containerId && window.klinecharts && window.klinecharts.dispose) {
          try { window.klinecharts.dispose(p.containerId); } catch (e) {}
        }
        p.chart = null;
        if (window.SimOverlays && window.SimOverlays.dropPaneMaps) {
          window.SimOverlays.dropPaneMaps(p.id);
        }
      }
      const row = document.getElementById('pane-row');
      if (row) row.querySelectorAll('.pane-cell, .pane-cell-empty').forEach((el) => el.remove());
    },
  };

  window.PaneManager = PaneManager;
  document.addEventListener('DOMContentLoaded', () => PaneManager.init());
})();
