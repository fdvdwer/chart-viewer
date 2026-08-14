/**
 * branch_panel.js — Right-side branch list panel.
 *
 * Phase 1 scope (per branching-replay-spec §8.1):
 *  - Read-only display: header count, scrollable list of branches,
 *    bottom summary block.
 *  - No actions wired yet (no rename/delete/promote/etc.) — just
 *    display + view-switch by clicking a row.
 *  - Subscribes to BranchEngine events and re-renders on change.
 *
 * Visual contract (spec §5.3):
 *  - 300 px wide, docked right of #main, dark theme matching sim_panel
 *  - Each row: kind dot · branch name + meta · net P/L
 *  - Bottom summary: 真實交易 / 真實淨損益 + exploration & hindsight totals
 *
 * Later phases extend this:
 *  - Phase 2: 「+ 新增」 button → manual fork modal
 *  - Phase 5: rename via double-click, right-click menu, action buttons
 *  - Phase 6: contamination warning row + history modal trigger
 */
(function () {
  // Spec §5.1: kind colors.
  const KIND_COLORS = {
    main: '#5a6478',
    exec: '#089981',
    direction: '#ef5350',
    sandbox: '#7d6cbf',
    archived: '#3a3f4b',
  };
  // Spec i18n §3.5: KIND_LABELS now maps to dictionary KEYS, not strings.
  // Read via I18n.t at render time so language flips show on the next
  // refresh.
  const KIND_LABEL_KEYS = {
    main:      'branch.kindMain',
    exec:      'branch.kindExec',
    direction: 'branch.kindDirection',
    sandbox:   'branch.kindSandbox',
    archived:  'branch.kindArchived',
  };

  const t_ = (key, vars) => (window.I18n && window.I18n.t)
    ? window.I18n.t(key, vars)
    : key;

  // Spec §4.4: only the auto-generated default branch name is
  // translated. User-renamed branches stay verbatim. The pill, the
  // panel rows, the summary footer, the fork-marker tooltip all
  // route through this helper.
  function displayBranchName(branch) {
    if (!branch) return t_('branch.kindMain');
    if (branch.kind === 'main' && (branch.name === '主線' || branch.name === 'Main')) {
      return t_('branch.kindMain');
    }
    return branch.name;
  }

  const Panel = {
    el: null,
    isOpen: false,

    init() {
      this.el = document.getElementById('branch-panel');

      // Spec i18n §4.3: re-render every dynamic surface this module
      // owns when the language changes — kind labels, state badges,
      // summary footer, branch pill, fork-tooltip. Idempotent guard
      // prevents listener stacking on hot-reload / re-init.
      if (!Panel._i18nWired) {
        Panel._i18nWired = true;
        document.addEventListener('i18n:change', () => {
          try { this.refresh(); }       catch (e) {}
          try { this._refreshPill(); }  catch (e) {}
        });
      }

      // Toolbar toggle button (added to topbar in index.html). Side
      // panel is optional; the rest of Phase 2 (toolbar fork button,
      // chart-side markers, branch pill) is independent of it.
      const toggle = document.getElementById('btn-branch-panel');
      if (toggle) toggle.addEventListener('click', () => this.toggle());

      // Header close button
      const close = document.getElementById('branch-panel-close');
      if (close) close.addEventListener('click', () => this.close());

      // Show-archived filter checkbox (spec §5.3.1)
      this._showArchived = false;
      const cb = document.getElementById('branch-show-archived');
      if (cb) {
        cb.checked = this._showArchived;
        cb.addEventListener('change', () => {
          this._showArchived = cb.checked;
          this.refresh();
        });
      }

      // ---- Phase 2 wiring ---------------------------------------------
      // Toolbar 「⋎ 在此分支」 fork button + chart-side markers + bar-select
      // mode (Alt+B) + branch pill. Each piece is self-contained; missing
      // DOM elements are tolerated (no-op).
      this._initForkButton();
      this._initBranchPill();
      this._initForkMarkers();
      this._initBarSelectMode();
      this._initHotkeys();
      // -----------------------------------------------------------------

      // Subscribe to BranchEngine events. Side panel re-renders on
      // every event; markers + pill refresh on the same beats so the
      // chart-side UI stays in lockstep with engine state.
      if (window.BranchEngine && window.BranchEngine.on) {
        const onChange = () => {
          this.refresh();
          this._refreshPill();
          this._renderMarkers();
        };
        window.BranchEngine.on('branchCreated', onChange);
        window.BranchEngine.on('branchDeleted', onChange);
        window.BranchEngine.on('branchRenamed', onChange);
        window.BranchEngine.on('branchUpdated', onChange);
        window.BranchEngine.on('activeBranchChanged', onChange);
        window.BranchEngine.on('miniBranchChanged', onChange);
        window.BranchEngine.on('branchPromoted', onChange);
      }
      // SimController doesn't emit events for trade fills yet, so we
      // hook a periodic refresh — cheap, only runs while panel is open.
      // Phase 5 will wire proper events when sim engine adds them.
      this._tradeRefreshHandle = null;
      this._startTradeRefreshLoop();

      // First paint
      this.refresh();
      this._refreshPill();
      this._renderMarkers();
    },

    /** Lightweight rAF-throttled poll while panel is open. Trades change
     *  silently inside SimEngine on every replay tick / market fill /
     *  bracket close — no event mechanism exists yet, so we re-read on
     *  each frame and short-circuit if nothing changed. Stops when the
     *  panel closes to avoid background work. */
    _startTradeRefreshLoop() {
      if (this._tradeRefreshHandle != null) return;
      let lastSig = null;
      const tick = () => {
        if (!this.isOpen) {
          this._tradeRefreshHandle = null;
          return;
        }
        // Cheap signature: total positions + their realised PnL sum.
        const eng = window.SimController && window.SimController.engine;
        let sig = '';
        if (eng) {
          const all = eng.getPositionHistory().concat(eng.getPositions());
          let pnlSum = 0;
          for (const p of all) {
            pnlSum += (p.realisedPnL || 0) + (p.unrealisedPnL || 0);
          }
          sig = all.length + ':' + pnlSum.toFixed(2);
        }
        if (sig !== lastSig) {
          lastSig = sig;
          this.refresh();
        }
        this._tradeRefreshHandle = requestAnimationFrame(tick);
      };
      this._tradeRefreshHandle = requestAnimationFrame(tick);
    },

    toggle() { this.isOpen ? this.close() : this.open(); },

    open() {
      if (!this.el) return;
      this.el.classList.remove('hidden');
      this.isOpen = true;
      const tbtn = document.getElementById('btn-branch-panel');
      if (tbtn) tbtn.classList.add('active');
      this._resizeChart();
      this._startTradeRefreshLoop();
      this.refresh();
    },

    close() {
      if (!this.el) return;
      this.el.classList.add('hidden');
      this.isOpen = false;
      const tbtn = document.getElementById('btn-branch-panel');
      if (tbtn) tbtn.classList.remove('active');
      this._resizeChart();
    },

    /** Same trick as sim_panel: opening/closing changes #main flex
     *  layout, KLineChart needs an explicit resize() to redraw into
     *  the new width. Defer one frame so reflow lands first. */
    _resizeChart() {
      const chart = (window.App && window.App.chart) || null;
      if (chart && chart.resize) {
        requestAnimationFrame(() => {
          try { chart.resize(); } catch (e) { /* ignore */ }
        });
      }
    },

    refresh() {
      if (!this.el || !window.BranchEngine) return;
      const Engine = window.BranchEngine;
      let branches = Engine.getBranches();
      if (!this._showArchived) {
        branches = branches.filter(b => b.kind !== 'archived');
      }
      const activeId = Engine.activeBranchId;
      const mainId = Engine.mainBranchId;
      const miniId = Engine.miniBranchId;
      const contam = Engine.contaminationCount;

      // Header count
      const countEl = this.el.querySelector('.branch-panel-count');
      if (countEl) countEl.textContent = `(${branches.length})`;

      // List rows
      const list = this.el.querySelector('.branch-list');
      if (list) {
        list.innerHTML = '';
        for (const b of branches) {
          list.appendChild(this._renderRow(b, { activeId, mainId, miniId }));
        }
        if (!branches.length) {
          const empty = document.createElement('div');
          empty.className = 'branch-list-empty';
          empty.textContent = t_('branch.empty');
          list.appendChild(empty);
        }
      }

      // Bottom summary (spec §5.3.4)
      this._renderSummary({ branches: Engine.getBranches(), mainId, contam });
    },

    _renderRow(branch, ctx) {
      const row = document.createElement('div');
      row.className = 'branch-row';
      row.dataset.branchId = branch.id;
      if (branch.id === ctx.activeId) row.classList.add('active');
      if (branch.id === ctx.mainId) row.classList.add('is-main');

      const kind = branch.kind || 'exec';
      const color = KIND_COLORS[kind] || '#888';
      const pnl = (window.BranchEngine.getNetPL(branch.id) || 0);
      const pnlAbs = Math.abs(pnl);
      const pnlSign = pnl >= 0 ? '+' : '−';
      const pnlText = `${pnlSign}$${pnlAbs.toFixed(0)}`;
      const pnlClass = pnl > 0 ? 'pos' : (pnl < 0 ? 'neg' : 'zero');

      const tradeCount = window.BranchEngine.getOwnTrades(branch.id).length;
      const kindLabel = KIND_LABEL_KEYS[kind] ? t_(KIND_LABEL_KEYS[kind]) : kind;
      const metaParts = [kindLabel];
      // Spec interpretation A — show fork timestamp prominently (instead
      // of just the bar index) so the user can cross-reference with the
      // K-bar's date/time on the chart axis. Bar index is kept in the
      // marker tooltip (§5.2.1) for users who want it.
      const lang = (window.I18n && window.I18n.lang) || 'zh';
      if (Number.isFinite(branch.forkBarTimestamp)) {
        const tsStr = formatBarTime(branch.forkBarTimestamp);
        metaParts.push(lang === 'en' ? `from ${tsStr}` : `自 ${tsStr} 起`);
      } else if (Number.isFinite(branch.forkBar)) {
        metaParts.push(t_('branch.barLabel', { n: branch.forkBar }));
      }
      // "{n}筆" / "{n} trades" — short row meta, inline since spec §3.5
      // doesn't define a key for this exact form.
      metaParts.push(lang === 'en' ? `${tradeCount} trades` : `${tradeCount}筆`);

      const stateBadge =
        branch.id === ctx.activeId ? `<span class="branch-state-badge view">${escapeHtml(t_('branch.viewing'))}</span>` :
        branch.id === ctx.miniId   ? `<span class="branch-state-badge mini">${escapeHtml(t_('branch.miniChart'))}</span>` :
        '';

      // Note indicator — small 📝 icon next to the name when the
      // branch has a non-empty title OR body. Hover shows the title
      // (or first body line if no title); click opens the editNote
      // modal so the user can read full body + edit both fields.
      // `data-edit-note` lets the row click handler recognise it
      // (otherwise the row-click setActiveBranch path would fire).
      const note = _normalizeNote(branch.note);
      const hasNote = !!(note.title || note.body);
      const tooltipText = note.title
        || (note.body ? note.body.split(/\n/)[0] : '');
      const noteIcon = hasNote
        ? `<span class="branch-note-icon" data-edit-note="1" title="${escapeHtml(_truncateNote(tooltipText))}">📝</span>`
        : '';

      // Mini-chart action buttons (Phase 4): visible on hover (or
      // always when this branch IS the mini, so the removal action
      // is always accessible). Main branch is excluded from the
      // 「放迷你」 path because comparing main against itself is
      // pointless — but if main is somehow already in the mini slot
      // (legacy session), still show 「移除」 so the user can clear it.
      const isMini = branch.id === ctx.miniId;
      // Mini-button labels not in spec §3.5 (TV-pattern terms are
      // close enough to translate inline): "副圖" / "Mini",
      // "移出副圖" / "Remove mini".
      const miniLabel = lang === 'en' ? 'Mini' : '副圖';
      const removeMiniLabel = lang === 'en' ? 'Remove mini' : '移出副圖';
      let miniBtnHtml = '';
      if (isMini) {
        miniBtnHtml = `<button class="branch-mini-btn is-mini" data-mini-action="clear">${escapeHtml(removeMiniLabel)}</button>`;
      } else if (branch.kind !== 'main') {
        miniBtnHtml = `<button class="branch-mini-btn" data-mini-action="set">${escapeHtml(miniLabel)}</button>`;
      }
      // Phase 5: hover-only 升格主線 button (spec §5.3.2 last row).
      // Hidden by CSS until row hover; main branch is excluded
      // (can't promote yourself).
      const promoteBtnHtml = (branch.kind !== 'main')
        ? `<button class="branch-promote-btn" data-action="promote" title="${escapeHtml(t_('branch.promoteTooltip'))}">${escapeHtml(t_('branch.promoteToMain'))}</button>`
        : '';

      row.innerHTML = `
        <span class="branch-dot" style="background:${color}"></span>
        <div class="branch-info">
          <div class="branch-name-row">
            <span class="branch-name">${escapeHtml(displayBranchName(branch))}</span>
            ${noteIcon}
            ${stateBadge}
          </div>
          <div class="branch-meta">${escapeHtml(metaParts.join(' · '))}</div>
        </div>
        <div class="branch-pnl ${pnlClass}">${pnlText}</div>
        <div class="branch-mini-actions">${miniBtnHtml}${promoteBtnHtml}</div>
      `;

      // Click row body → switch active branch (cheap, frequent).
      // Skip if the click landed on the inline rename input, the
      // note icon, or a mini-action button (each has its own handler).
      row.addEventListener('click', (e) => {
        if (e.target.closest('.branch-name-edit')) return;
        if (e.target.closest('[data-edit-note]')) return;
        if (e.target.closest('[data-mini-action]')) return;
        window.BranchEngine.setActiveBranch(branch.id);
      });

      // Mini-chart action buttons — set / clear miniBranchId.
      const miniBtn = row.querySelector('[data-mini-action]');
      if (miniBtn) {
        miniBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!window.BranchEngine || !window.BranchEngine.setMiniBranch) return;
          const action = miniBtn.dataset.miniAction;
          if (action === 'set')   window.BranchEngine.setMiniBranch(branch.id);
          if (action === 'clear') window.BranchEngine.setMiniBranch(null);
        });
      }
      // Phase 5: 升格主線 hover button — routes to Phase 6 stub.
      const promoteBtn = row.querySelector('.branch-promote-btn');
      if (promoteBtn) {
        promoteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          _promoteStub(branch);
        });
      }

      // Click 📝 icon → open editNote modal (view + edit). Stopping
      // propagation here is what `data-edit-note` filters above; we
      // also stop here so a double-handler doesn't fire.
      const noteIconEl = row.querySelector('.branch-note-icon');
      if (noteIconEl) {
        noteIconEl.addEventListener('click', (e) => {
          e.stopPropagation();
          _openEditNoteModal(branch);
        });
      }

      // Right-click → context menu (Phase 5: 重新命名 / 編輯備註 /
      // 刪除分支). Main branch's delete entry is disabled because the
      // engine refuses to delete kind === 'main'.
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _openRowContextMenu(branch, e.pageX, e.pageY);
      });

      // Double-click on the name → inline rename.
      const nameEl = row.querySelector('.branch-name');
      if (nameEl) {
        nameEl.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          _beginInlineRename(nameEl, branch);
        });
      }

      return row;
    },

    _renderSummary({ branches, mainId, contam }) {
      const summary = this.el.querySelector('.branch-summary');
      if (!summary) return;

      const Engine = window.BranchEngine;
      const main = Engine.getBranch(mainId);
      const mainTrades = main ? Engine.getOwnTrades(mainId).length : 0;
      const mainPnL = main ? Engine.getNetPL(mainId) : 0;

      // Exploration = exec kind branches (excluding main)
      // Hindsight = direction + sandbox kinds
      let exploreCount = 0, hindsightCount = 0;
      for (const b of branches) {
        if (b.kind === 'exec' && b.id !== mainId) exploreCount++;
        if (b.kind === 'direction' || b.kind === 'sandbox') hindsightCount++;
      }
      const totalNonMain = branches.filter(b =>
        b.id !== mainId && b.kind !== 'archived').length;

      const fmtPnL = (n) => {
        const abs = Math.abs(n);
        const sign = n >= 0 ? '+' : '−';
        return `${sign}$${abs.toFixed(0)}`;
      };
      const mainPnLClass = mainPnL > 0 ? 'pos' : (mainPnL < 0 ? 'neg' : 'zero');

      // Summary row labels are not in spec §3.5's master dictionary.
      // Translate inline — these are zh-only strings paired with
      // factual English equivalents. zh phrasing kept verbatim.
      const lang = (window.I18n && window.I18n.lang) || 'zh';
      const L = lang === 'en' ? {
        realTrades:    'Real trades (main only)',
        realNetPnL:    'Real net P&L',
        exploreBr:     'Exploration branches',
        hindsightSub:  '  Hindsight branches (direction / sandbox)',
        contamFmt:     (n) => `⚠ Main has been promoted ${n} time${n === 1 ? '' : 's'}`,
        viewLink:      '[View]',
      } : {
        realTrades:    '真實交易 (僅主線)',
        realNetPnL:    '真實淨損益',
        exploreBr:     '探索分支',
        hindsightSub:  '　事後分支 (方向/沙盒)',
        contamFmt:     (n) => `⚠ 主線已被升格 ${n} 次`,
        viewLink:      '[查看]',
      };
      let html = `
        <div class="summary-row main-real">
          <span>${L.realTrades}</span>
          <span class="summary-val">${mainTrades}</span>
        </div>
        <div class="summary-row main-real">
          <span>${L.realNetPnL}</span>
          <span class="summary-val ${mainPnLClass}">${fmtPnL(mainPnL)}</span>
        </div>
        <div class="summary-divider"></div>
        <div class="summary-row">
          <span>${L.exploreBr}</span>
          <span class="summary-val">${totalNonMain}</span>
        </div>
        <div class="summary-row sub">
          <span>${L.hindsightSub}</span>
          <span class="summary-val">${hindsightCount}</span>
        </div>
      `;
      if (contam > 0) {
        html += `
          <div class="summary-divider"></div>
          <div class="summary-row contam">
            <span>${L.contamFmt(contam)}</span>
            <button class="summary-link" id="branch-history-open">${L.viewLink}</button>
          </div>
        `;
      }
      summary.innerHTML = html;
      // Wire the [查看] click → promotion history modal. The modal
      // itself lands in Step 3; until then we toast a placeholder so
      // the click isn't dead silent (matches the no-op-discoverability
      // policy used by _promoteStub before this commit).
      const historyBtn = summary.querySelector('#branch-history-open');
      if (historyBtn) {
        historyBtn.addEventListener('click', () => {
          if (window.BranchModals && window.BranchModals.promotionHistory) {
            window.BranchModals.promotionHistory();
          } else {
            _showToast(t_('branch.toastModalSoon'));
          }
        });
      }
    },

    // ==================================================================
    // Phase 2 — toolbar fork button (§5.1) + bar-select mode (§3.2.2)
    // + chart-side ⋎ markers (§5.2) + branch pill (§5.1).
    // ==================================================================

    _initForkButton() {
      this._forkBtn = document.getElementById('btn-branch-fork');
      if (!this._forkBtn) return;
      this._forkBtn.addEventListener('click', () => this._handleForkButtonClick());
    },

    _initBranchPill() {
      this._pillEl = document.getElementById('branch-pill');
    },

    _initForkMarkers() {
      this._markersEl = document.getElementById('branch-fork-markers');
      this._tooltipEl = document.getElementById('branch-fork-tooltip');
      if (!this._markersEl) return;
      // rAF loop keeps marker X positions locked to the chart's data
      // axis through pan / zoom. Skips work entirely when there are
      // no markers (the common case for new users on the main branch).
      const tick = () => {
        if (this._markersEl.children.length > 0) {
          this._positionMarkers();
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      // Click-outside closes the tooltip popover.
      document.addEventListener('click', (e) => {
        if (!this._tooltipEl || this._tooltipEl.hidden) return;
        if (this._tooltipEl.contains(e.target)) return;
        if (e.target.closest && e.target.closest('.branch-fork-marker')) return;
        this._closeForkTooltip();
      });
    },

    _initBarSelectMode() {
      this._barSelectActive = false;
      this._previewEl = document.getElementById('branch-bar-select-preview');
      this._barSelectMouseMove = null;
      this._barSelectClick = null;
    },

    _initHotkeys() {
      // Alt+B enters bar-select mode (§3.2.2). ESC exits when active.
      // (Alt+F is the fibo-retracement drawing tool — keep them distinct.)
      // Don't hijack keys while typing in inputs / textareas.
      document.addEventListener('keydown', (e) => {
        const tag = (e.target && e.target.tagName) || '';
        const inForm = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
        if (e.altKey && (e.key === 'b' || e.key === 'B') && !inForm) {
          e.preventDefault();
          this._toggleBarSelectMode();
          return;
        }
        if (e.key === 'Escape' && this._barSelectActive && !inForm) {
          e.preventDefault();
          this._exitBarSelectMode();
        }
      });
    },

    /** Compute the bar to fork from when the user clicks the toolbar
     *  「⋎ 在此分支」 button. Replay cursor wins if active; otherwise
     *  fall back to the latest real bar in App.currentBars. */
    _currentForkContext() {
      const App = window.App;
      const Replay = window.Replay;
      let barIdx = -1, ts = null;
      if (Replay && Replay.active && Number.isFinite(Replay.cursorBarIdx)) {
        barIdx = Replay.cursorBarIdx;
        const bars = (Replay.baseBars && Replay.baseBars.length)
          ? Replay.baseBars : (App && App.currentBars) || [];
        if (bars[barIdx]) ts = bars[barIdx].timestamp;
      }
      if (ts == null) {
        const bars = (App && App.currentBars) || [];
        if (!bars.length) return null;
        // Find latest non-placeholder bar
        for (let i = bars.length - 1; i >= 0; i--) {
          if (bars[i] && !bars[i]._placeholder) {
            barIdx = i;
            ts = bars[i].timestamp;
            break;
          }
        }
      }
      if (ts == null) return null;
      const parent = window.BranchEngine.getActiveBranch();
      return {
        barIdx,
        ts,
        parentName: displayBranchName(parent),
      };
    },

    _handleForkButtonClick() {
      // If already in bar-select mode, treat second click as exit.
      if (this._barSelectActive) {
        this._exitBarSelectMode();
        return;
      }
      const ctx = this._currentForkContext();
      if (!ctx) return;
      this._openForkModal(ctx);
    },

    /** Open the manual-fork modal targeting `ctx.barIdx`. Resolves
     *  → BranchEngine.createBranch + setActiveBranch. */
    async _openForkModal(ctx) {
      if (!window.BranchModals || !window.BranchModals.manualFork) return;
      const defaultName = 'branch-' + window.BranchEngine.getBranches().length;
      const result = await window.BranchModals.manualFork({
        parentName: ctx.parentName,
        forkBarLabel: t_('branch.barLabel', { n: ctx.barIdx + 1 }),
        forkBarTimestamp: ctx.ts,
        defaultName,
      });
      if (!result || !result.confirmed) return;
      const branch = window.BranchEngine.createBranch({
        name: result.name,
        kind: result.kind,
        note: result.note,
        forkBar: ctx.barIdx,
        forkBarTimestamp: ctx.ts,
      });
      // Switch active branch to the newly-created one so subsequent
      // trades land on it (spec §8.2: "After fork: switch
      // activeBranchId").
      window.BranchEngine.setActiveBranch(branch.id);
    },

    // -------- Bar-select mode (§3.2.2) ---------------------------------

    _toggleBarSelectMode() {
      if (this._barSelectActive) this._exitBarSelectMode();
      else this._enterBarSelectMode();
    },

    _enterBarSelectMode() {
      this._barSelectActive = true;
      document.body.classList.add('branch-bar-select-active');
      if (this._forkBtn) this._forkBtn.classList.add('active');
      // Disable chart pan/zoom so click-to-fork doesn't compete with
      // the chart's drag-pan handler. Restored on exit.
      const chart = window.App && window.App.chart;
      if (chart) {
        try { chart.setScrollEnabled(false); } catch (e) {}
        try { chart.setZoomEnabled(false); } catch (e) {}
      }
      if (this._previewEl) this._previewEl.hidden = false;
      this._barSelectMouseMove = (e) => this._onBarSelectMove(e);
      this._barSelectClick = (e) => this._onBarSelectClick(e);
      document.addEventListener('mousemove', this._barSelectMouseMove);
      // Capture phase so we beat the chart's own click handlers.
      document.addEventListener('click', this._barSelectClick, true);
    },

    _exitBarSelectMode() {
      if (!this._barSelectActive) return;
      this._barSelectActive = false;
      document.body.classList.remove('branch-bar-select-active');
      if (this._forkBtn) this._forkBtn.classList.remove('active');
      const chart = window.App && window.App.chart;
      if (chart) {
        try { chart.setScrollEnabled(true); } catch (e) {}
        try { chart.setZoomEnabled(true); } catch (e) {}
      }
      if (this._previewEl) this._previewEl.hidden = true;
      if (this._barSelectMouseMove) {
        document.removeEventListener('mousemove', this._barSelectMouseMove);
        this._barSelectMouseMove = null;
      }
      if (this._barSelectClick) {
        document.removeEventListener('click', this._barSelectClick, true);
        this._barSelectClick = null;
      }
    },

    _onBarSelectMove(e) {
      const chart = window.App && window.App.chart;
      const area = document.getElementById('chart-area');
      if (!chart || !area || !this._previewEl) return;
      const rect = area.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Outside the chart area → fade the preview but keep mode active.
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
        this._previewEl.style.opacity = '0';
        return;
      }
      this._previewEl.style.opacity = '1';
      // Snap X to the nearest bar's center via convertFromPixel +
      // convertToPixel round-trip — same trick replay.js uses for the
      // pick-bar overlay.
      try {
        const pt = chart.convertFromPixel({ x, y: 0 }, { paneId: 'candle_pane' });
        const data = Array.isArray(pt) ? pt[0] : pt;
        if (!data || !Number.isFinite(data.dataIndex)) return;
        const back = chart.convertToPixel(
          [{ dataIndex: data.dataIndex, value: 0 }],
          { paneId: 'candle_pane' });
        const snapX = Array.isArray(back) ? (back[0] && back[0].x) : (back && back.x);
        if (Number.isFinite(snapX)) {
          this._previewEl.style.left = snapX + 'px';
          this._previewEl.style.top  = (rect.height / 2) + 'px';
        }
      } catch (err) { /* ignore convert errors at chart edge */ }
    },

    _onBarSelectClick(e) {
      const chart = window.App && window.App.chart;
      const area = document.getElementById('chart-area');
      if (!chart || !area) return;
      // Only intercept clicks that landed on the chart canvas / its
      // children (not on the toolbar, side panel, or open modals).
      if (!area.contains(e.target)) return;
      // Ignore clicks on the toolbar fork button itself (it lives in
      // the topbar, not chart-area, but defensively check).
      if (e.target.closest && e.target.closest('#btn-branch-fork')) return;
      const rect = area.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) return;
      let barIdx = null;
      try {
        const pt = chart.convertFromPixel({ x, y }, { paneId: 'candle_pane' });
        const data = Array.isArray(pt) ? pt[0] : pt;
        if (data && Number.isFinite(data.dataIndex)) barIdx = data.dataIndex;
      } catch (err) {}
      if (barIdx == null) return;
      e.preventDefault();
      e.stopPropagation();
      // Resolve timestamp from App.currentBars (TF-current data)
      const bars = (window.App && window.App.currentBars) || [];
      if (!bars[barIdx]) { this._exitBarSelectMode(); return; }
      const ctx = {
        barIdx,
        ts: bars[barIdx].timestamp,
        parentName: window.BranchEngine.getActiveBranch().name,
      };
      this._exitBarSelectMode();
      this._openForkModal(ctx);
    },

    // -------- Chart-side ⋎ fork markers (§5.2) -------------------------

    _renderMarkers() {
      if (!this._markersEl || !window.BranchEngine) return;
      const branches = window.BranchEngine.getBranches();
      // The branch currently displayed in the mini chart already has
      // its own ⋎ glyph at the top of the mini's purple line — a
      // duplicate main-chart marker on top of that just stacks on the
      // mini's glyph at the same X. Filter the mini branch out of the
      // marker grouping so the mini's glyph is the sole indicator.
      // Other branches that share the same forkBar still get their
      // marker (the group only disappears if mini was the ONLY branch
      // at that bar).
      const miniId = window.BranchEngine.miniBranchId || null;
      // Group branches by forkBarTimestamp (multiple branches can fork
      // from the same bar — a single shared marker per bar).
      const groups = new Map();
      for (const b of branches) {
        if (!Number.isFinite(b.forkBarTimestamp)) continue;
        if (miniId && b.id === miniId) continue;
        const key = String(b.forkBarTimestamp);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(b);
      }
      // Diff existing children against wanted keys.
      for (const child of Array.from(this._markersEl.children)) {
        if (!groups.has(child.dataset.forkTs)) child.remove();
      }
      for (const [tsKey, bs] of groups) {
        let el = this._markersEl.querySelector(
          `.branch-fork-marker[data-fork-ts="${tsKey}"]`);
        if (!el) {
          el = this._createMarkerEl(tsKey);
          this._markersEl.appendChild(el);
        }
        this._updateMarkerEl(el, tsKey, bs);
      }
      this._positionMarkers();
    },

    _createMarkerEl(tsKey) {
      const el = document.createElement('div');
      el.className = 'branch-fork-marker';
      el.dataset.forkTs = tsKey;
      el.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 5 L12 16 L19 5"/>
        </svg>`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const ts = parseFloat(el.dataset.forkTs);
        if (!Number.isFinite(ts)) return;
        // Re-resolve the branch group at click time (it may have
        // changed since createMarkerEl ran — branch added / renamed).
        const branches = window.BranchEngine.getBranches().filter(
          b => Number.isFinite(b.forkBarTimestamp)
            && Math.abs(b.forkBarTimestamp - ts) < 1);
        this._openForkTooltip(el, ts, branches);
      });
      return el;
    },

    _updateMarkerEl(el, tsKey, branches) {
      // "Most severe" kind colors the marker (spec §5.2 priority order).
      const KIND_PRIORITY = { direction: 4, sandbox: 3, exec: 2, archived: 1, main: 0 };
      let topKind = 'exec', topScore = -1;
      for (const b of branches) {
        const s = KIND_PRIORITY[b.kind] != null ? KIND_PRIORITY[b.kind] : 0;
        if (s > topScore) { topScore = s; topKind = b.kind; }
      }
      el.className = 'branch-fork-marker kind-' + topKind;
      el.dataset.forkTs = tsKey;
      el.dataset.kind = topKind;
      el.dataset.count = String(branches.length);
    },

    _positionMarkers() {
      if (!this._markersEl) return;
      const chart = window.App && window.App.chart;
      if (!chart || !chart.convertToPixel) return;
      // Collect all markers + timestamps in one pass, then do a SINGLE
      // batched convertToPixel call. Mirrors sim_panel's optimization;
      // this rAF loop runs every frame, so cutting N kchart calls down
      // to 1 frees up frame budget for the chart's own pan/zoom redraw.
      //
      // Each query carries `value = bar.close at that timestamp` so the
      // returned pixel.y reflects WHERE THE BAR IS on screen — used
      // below to flip the chevron direction (point UP when bars are
      // above the marker, DOWN when bars are below).
      const els = [];
      const tsList = [];
      const valueList = [];
      const bars = (window.App && window.App.currentBars) || [];
      for (const el of this._markersEl.children) {
        const ts = parseFloat(el.dataset.forkTs);
        if (!Number.isFinite(ts)) continue;
        els.push(el);
        tsList.push(ts);
        // Look up the bar at this timestamp; fall back to 0 if no bar
        // (marker outside data range — direction stays default).
        const idx = (typeof findDataIndexByTimestamp === 'function')
          ? findDataIndexByTimestamp(bars, ts) : -1;
        const v = (idx >= 0 && bars[idx] && Number.isFinite(bars[idx].close))
          ? bars[idx].close : 0;
        valueList.push(v);
      }
      if (!els.length) return;

      let pixels;
      try {
        pixels = chart.convertToPixel(
          tsList.map((ts, i) => ({ timestamp: ts, value: valueList[i] })),
          { paneId: 'candle_pane' });
      } catch (err) { return; }
      if (!Array.isArray(pixels)) return;

      const area = document.getElementById('chart-area');
      const midY = area ? area.clientHeight / 2 : 200;
      const w    = area ? area.clientWidth : 1000;
      // Write-only loop — no reads → no forced layout flush per write.
      for (let i = 0; i < els.length; i++) {
        const x = pixels[i] && pixels[i].x;
        if (!Number.isFinite(x)) continue;
        const el = els[i];
        el.style.left = x + 'px';
        el.style.top  = midY + 'px';
        // Direction: if the bar's price Y is ABOVE the marker (smaller
        // pixel y in canvas coords), the bar lives in the upper half
        // of the viewport relative to the marker → flip the chevron
        // up so it visually points toward the bars. Else keep default
        // (points down). Falls back to default when bar lookup failed
        // (valueList[i] === 0 → very low Y, treated as "below").
        const barY = pixels[i] && pixels[i].y;
        const pointsUp = Number.isFinite(barY)
          && valueList[i] !== 0
          && barY < midY;
        el.classList.toggle('points-up', pointsUp);
        // Hide markers scrolled off the visible chart (kchart still
        // returns extrapolated X for off-screen timestamps).
        el.style.visibility = (x < -20 || x > w + 20) ? 'hidden' : 'visible';
      }
    },

    _openForkTooltip(markerEl, ts, branches) {
      if (!this._tooltipEl) return;
      // Sort: main first, then by createdAt asc.
      const sorted = branches.slice().sort((a, b) => {
        if (a.kind === 'main') return -1;
        if (b.kind === 'main') return 1;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
      const activeId = window.BranchEngine.activeBranchId;
      // Find bar index for the title row.
      const bars = (window.App && window.App.currentBars) || [];
      let barLabel = '?';
      for (let i = 0; i < bars.length; i++) {
        if (bars[i].timestamp === ts) { barLabel = String(i + 1); break; }
      }
      const tsLabel = formatBarTime(ts);
      const rows = sorted.map((b) => {
        const pnl = window.BranchEngine.getNetPL(b.id);
        const sign = pnl >= 0 ? '+' : '−';
        const pnlText = `${sign}$${Math.abs(pnl).toFixed(0)}`;
        const pnlClass = pnl > 0 ? 'pos' : (pnl < 0 ? 'neg' : 'zero');
        const isCurrent = b.id === activeId;
        const labelExtra = isCurrent ? ' <span class="branch-fork-tt-current">(current)</span>' : '';
        return `
          <button type="button" class="branch-fork-tt-row${isCurrent ? ' active' : ''}"
                  data-branch-id="${escapeHtml(b.id)}">
            <span class="branch-fork-tt-dot kind-${escapeHtml(b.kind || 'exec')}"></span>
            <span class="branch-fork-tt-name">${escapeHtml(displayBranchName(b))}${labelExtra}</span>
            <span class="branch-fork-tt-pnl ${pnlClass}">${pnlText}</span>
          </button>
        `;
      }).join('');
      // Spec §3.5 branch.forkPointHeader / branch.barLabel.
      const headerText = t_('branch.forkPointHeader', { ts: tsLabel });
      const barLabelText = t_('branch.barLabel', { n: barLabel });
      this._tooltipEl.innerHTML = `
        <div class="branch-fork-tt-header">${escapeHtml(headerText)} <span class="branch-fork-tt-bar">${escapeHtml(barLabelText)}</span></div>
        <div class="branch-fork-tt-rows">${rows}</div>
      `;
      this._tooltipEl.hidden = false;
      // Position next to the marker (right side, offset +24 px).
      const markerRect = markerEl.getBoundingClientRect();
      const area = document.getElementById('chart-area');
      const areaRect = area.getBoundingClientRect();
      let left = (markerRect.left - areaRect.left) + 30;
      let top  = (markerRect.top - areaRect.top) - 8;
      // Flip horizontally if it'd run past the right edge.
      const ttW = 240;  // matches CSS min-width
      if (left + ttW > areaRect.width) {
        left = (markerRect.left - areaRect.left) - ttW - 6;
      }
      this._tooltipEl.style.left = Math.max(4, left) + 'px';
      this._tooltipEl.style.top  = Math.max(4, top)  + 'px';
      // Wire row clicks → switch active branch.
      this._tooltipEl.querySelectorAll('.branch-fork-tt-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = row.dataset.branchId;
          if (id) window.BranchEngine.setActiveBranch(id);
          this._closeForkTooltip();
        });
      });
    },

    _closeForkTooltip() {
      if (this._tooltipEl) this._tooltipEl.hidden = true;
    },

    // -------- Branch pill (toolbar) ------------------------------------

    _refreshPill() {
      if (!this._pillEl) return;
      const Engine = window.BranchEngine;
      if (!Engine) { this._pillEl.hidden = true; return; }
      const branches = Engine.getBranches();
      // Hide pill when there's only the main branch — clutter for
      // single-branch users. Becomes useful as soon as forks exist.
      if (branches.length <= 1) {
        this._pillEl.hidden = true;
        return;
      }
      const active = Engine.getActiveBranch();
      if (!active) { this._pillEl.hidden = true; return; }
      this._pillEl.hidden = false;
      this._pillEl.className = 'branch-pill kind-' + (active.kind || 'main');
      const nameEl = this._pillEl.querySelector('.branch-pill-name');
      if (nameEl) nameEl.textContent = displayBranchName(active);
      // Contamination badge — populated only when promotion has happened
      // (Phase 6). Always visible thereafter, never goes away.
      const contam = Engine.contaminationCount;
      const contamEl = this._pillEl.querySelector('.branch-pill-contam');
      if (contamEl) {
        if (contam > 0) {
          contamEl.hidden = false;
          contamEl.textContent = '⚠×' + contam;
        } else {
          contamEl.hidden = true;
        }
      }
    },
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;',
      '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  /** Truncate a note to a sane length for the native tooltip. Keeps
   *  newlines so multi-line notes stay readable in the popup. */
  function _truncateNote(s, max = 100) {
    s = String(s || '');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  /** Normalize stored note value to `{ title, body }`. Mirrors the
   *  engine's `_normalizeNote` so panel renders are tolerant of
   *  legacy (string) notes left over from previous sessions. */
  function _normalizeNote(note) {
    if (note == null) return { title: '', body: '' };
    if (typeof note === 'string') return { title: '', body: note };
    if (typeof note === 'object') {
      return {
        title: String(note.title || ''),
        body:  String(note.body  || ''),
      };
    }
    return { title: '', body: '' };
  }

  /** Open the editNote modal for a given branch and persist on
   *  confirm. Used by both the 📝 icon click and the right-click
   *  menu's 編輯備註 entry. */
  async function _openEditNoteModal(branch) {
    if (!window.BranchModals || !window.BranchModals.editNote) return;
    if (!window.BranchEngine || !window.BranchEngine.updateNote) return;
    const cur = _normalizeNote(branch.note);
    const result = await window.BranchModals.editNote({
      branchName: branch.name,
      title: cur.title,
      body:  cur.body,
    });
    if (!result.confirmed) return;
    window.BranchEngine.updateNote(branch.id, {
      title: result.title,
      body:  result.body,
    });
    // Engine emits branchUpdated → panel auto-refreshes.
  }

  // ===================================================================
  // Phase 5 — row interactions (context menu + inline rename)
  // ===================================================================

  let _ctxMenuEl = null;
  function _ensureRowCtxMenu() {
    if (_ctxMenuEl) return _ctxMenuEl;
    const el = document.createElement('div');
    el.id = 'branch-row-ctx';
    el.hidden = true;
    document.body.appendChild(el);
    // Outside-click + Esc close
    document.addEventListener('mousedown', (e) => {
      if (el.hidden) return;
      if (!el.contains(e.target)) _hideRowCtxMenu();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (!el.hidden && e.key === 'Escape') _hideRowCtxMenu();
    });
    window.addEventListener('blur',   _hideRowCtxMenu);
    window.addEventListener('resize', _hideRowCtxMenu);
    _ctxMenuEl = el;
    return el;
  }

  function _hideRowCtxMenu() {
    if (_ctxMenuEl) _ctxMenuEl.hidden = true;
  }

  /** Per spec §5.3.3 the context menu has 5 items; we generate
   *  innerHTML dynamically each open since the mini-toggle item's
   *  label flips depending on miniBranchId state, and disabled
   *  flags depend on `branch.kind === 'main'`. */
  function _openRowContextMenu(branch, pageX, pageY) {
    const menu = _ensureRowCtxMenu();
    const Engine = window.BranchEngine;
    const isMain = branch.kind === 'main';
    const isMini = Engine && branch.id === Engine.miniBranchId;

    const items = [
      { act: 'rename',   label: t_('branch.ctxRename') },
      { act: 'note',     label: t_('branch.ctxNote') },
      { sep: true },
      isMini
        ? { act: 'unmini', label: t_('branch.ctxUnmini') }
        : { act: 'mini',   label: t_('branch.ctxMini'), disabled: isMain },
      { act: 'promote', label: t_('branch.ctxPromote'), disabled: isMain },
      { sep: true },
      { act: 'delete', label: t_('branch.ctxDelete'),
        disabled: isMain, danger: true },
    ];

    menu.innerHTML = items.map((it) => {
      if (it.sep) return '<div class="ctx-sep"></div>';
      const cls = ['ctx-item',
        it.danger ? 'danger' : '',
        it.disabled ? 'disabled' : '',
      ].filter(Boolean).join(' ');
      return `<div class="${cls}" data-act="${it.act}">${escapeHtml(it.label)}</div>`;
    }).join('');

    menu.querySelectorAll('.ctx-item').forEach((item) => {
      const act = item.dataset.act;
      item.onclick = (e) => {
        e.stopPropagation();
        if (item.classList.contains('disabled')) return;
        _hideRowCtxMenu();
        _handleCtxAction(act, branch);
      };
    });

    // Position with viewport clamping.
    menu.hidden = false;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const x = Math.min(pageX, window.innerWidth - w - 5);
    const y = Math.min(pageY, window.innerHeight - h - 5);
    menu.style.left = Math.max(0, x) + 'px';
    menu.style.top  = Math.max(0, y) + 'px';
  }

  function _handleCtxAction(act, branch) {
    const Engine = window.BranchEngine;
    if (act === 'rename') {
      const row = document.querySelector(
        `.branch-row[data-branch-id="${branch.id}"]`);
      const nameEl = row && row.querySelector('.branch-name');
      if (nameEl) _beginInlineRename(nameEl, branch);
      return;
    }
    if (act === 'note')   { _openEditNoteModal(branch); return; }
    if (act === 'delete') { _confirmDeleteBranch(branch); return; }
    if (act === 'mini') {
      if (Engine && Engine.setMiniBranch) Engine.setMiniBranch(branch.id);
      return;
    }
    if (act === 'unmini') {
      if (Engine && Engine.setMiniBranch) Engine.setMiniBranch(null);
      return;
    }
    if (act === 'promote') { _promoteStub(branch); return; }
  }

  /** Phase 6 promote entry point — invoked from the row hover button
   *  AND the right-click context menu (both routes are fed by the
   *  same `_handleCtxAction(act='promote')` hub). Walks the user
   *  through `BranchModals.promotionFlow` (3-step gauntlet) and, if
   *  they actually finish it, calls `BranchEngine.promoteBranch`
   *  with the typed reason.
   *
   *  Spec §4.3 friction is enforced inside the modal (cooldown,
   *  type-to-confirm, ≥20 char reason). Engine has its own minimum
   *  validation (length / type) so a malformed call still fails
   *  safely — but we shouldn't reach that path because the modal
   *  filters first. */
  async function _promoteStub(branch) {
    if (!window.BranchModals || !window.BranchModals.promotionFlow) {
      _showToast(t_('branch.toastModalUnloaded'));
      return;
    }
    const Engine = window.BranchEngine;
    if (!Engine || !Engine.promoteBranch) {
      _showToast(t_('branch.toastEngineUnloaded'));
      return;
    }
    const currentMain = Engine.getMainBranch && Engine.getMainBranch();
    const currentMainName = displayBranchName(currentMain);
    const contamCountAfter = (Engine.contaminationCount || 0) + 1;

    const result = await window.BranchModals.promotionFlow({
      branchName: displayBranchName(branch),
      currentMainName,
      contamCountAfter,
    });
    if (!result || !result.confirmed) return;

    const ok = Engine.promoteBranch(branch.id, result.reason);
    if (ok) {
      // "{name} 已升格為主線" not in spec §3.5 — inline.
      const lang = (window.I18n && window.I18n.lang) || 'zh';
      const branchName = displayBranchName(branch);
      _showToast(lang === 'en'
        ? `"${branchName}" promoted to Main`
        : `「${branchName}」 已升格為主線`);
    } else {
      _showToast(t_('branch.toastPromoteFailed'));
    }
  }

  /** Tiny ephemeral toast — same UX as SimHistory's toast but our own
   *  DOM root so the two don't clobber each other if both fire close
   *  in time. Matches `#sim-history-toast` styling. */
  function _showToast(msg) {
    let host = document.getElementById('branch-toast');
    if (!host) {
      host = document.createElement('div');
      host.id = 'branch-toast';
      document.body.appendChild(host);
    }
    host.textContent = msg;
    host.classList.add('show');
    clearTimeout(host._timer);
    host._timer = setTimeout(() => host.classList.remove('show'), 2500);
  }

  /** Replace the static `.branch-name` span with an editable input.
   *  Commits on blur / Enter; cancels on Esc. */
  function _beginInlineRename(nameEl, branch) {
    if (!nameEl || nameEl.dataset.editing === '1') return;
    if (!window.BranchEngine || !window.BranchEngine.renameBranch) return;
    const original = branch.name || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'branch-name-edit';
    input.value = original;
    input.maxLength = 40;
    nameEl.dataset.editing = '1';
    nameEl.replaceWith(input);
    // Defer focus so the click that triggered dblclick doesn't blur it.
    requestAnimationFrame(() => { input.focus(); input.select(); });

    let done = false;
    const commit = () => {
      if (done) return; done = true;
      const val = input.value.trim();
      if (val && val !== original) {
        window.BranchEngine.renameBranch(branch.id, val);
        // The branchRenamed event triggers panel.refresh() which
        // rebuilds the row; nothing else to do here.
      } else {
        // No change — restore the original span (no engine call,
        // no refresh) so the input doesn't linger.
        const span = document.createElement('span');
        span.className = 'branch-name';
        span.textContent = original;
        input.replaceWith(span);
      }
    };
    const cancel = () => {
      if (done) return; done = true;
      const span = document.createElement('span');
      span.className = 'branch-name';
      span.textContent = original;
      input.replaceWith(span);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();   // don't let global Del / Ctrl+Z fire
      if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  }

  async function _confirmDeleteBranch(branch) {
    if (!window.BranchModals || !window.BranchModals.deleteBranch) return;
    if (!window.BranchEngine || !window.BranchEngine.deleteBranch) return;
    const Engine = window.BranchEngine;
    const parent = branch.parentId ? Engine.getBranch(branch.parentId) : null;
    const tradeCount = Engine.getOwnTrades(branch.id).length;
    const result = await window.BranchModals.deleteBranch({
      branchName: displayBranchName(branch),
      parentName: displayBranchName(parent),
      tradeCount,
    });
    if (!result.confirmed) return;
    Engine.deleteBranch(branch.id);
    // Engine emits branchDeleted → panel auto-refreshes via existing
    // listener. No additional plumbing needed here.
  }

  /** Format a unix-ms timestamp as MM/DD HH:MM in ET (matches the
   *  chart's display timezone so users can cross-reference with the
   *  K-bar they see). Used in panel meta / fork-marker tooltip / fork
   *  modal subtitle so the user can see WHEN they forked, not just
   *  the bar index. */
  function formatBarTime(ts) {
    if (!Number.isFinite(ts)) return '?';
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
        hour12: false,
      });
      const parts = fmt.formatToParts(new Date(ts));
      const get = (type) => {
        const p = parts.find((x) => x.type === type);
        return p ? p.value : '';
      };
      return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
    } catch (e) {
      return '?';
    }
  }

  /** Long form including year — `YYYY/MM/DD HH:MM`. Used by trade
   *  history (table + xlsx export) where the same MM/DD might span
   *  multiple years across many backtests and the user needs to
   *  disambiguate. Other UI surfaces (panel meta, fork tooltip, fork
   *  modal subtitle) intentionally stay on the short form to keep
   *  the rows compact. */
  function formatBarTimeFull(ts) {
    if (!Number.isFinite(ts)) return '?';
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
        hour12: false,
      });
      const parts = fmt.formatToParts(new Date(ts));
      const get = (type) => {
        const p = parts.find((x) => x.type === type);
        return p ? p.value : '';
      };
      return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
    } catch (e) {
      return '?';
    }
  }
  // Expose so other modules (sim_history, branch_modals) can format
  // timestamps consistently.
  window.formatBarTime = formatBarTime;
  window.formatBarTimeFull = formatBarTimeFull;

  window.BranchPanel = Panel;
})();
