/**
 * sim_history.js — Trade history bottom drawer (TradingView-style 交易清單).
 *
 * Inspired by TradingView's "歷史數據交易 → 交易清單" panel: a tabular
 * view of every trade (closed or open) with two visually-grouped rows
 * per trade (entry / exit) and per-trade metrics:
 *   交易#  類型  進場行/出場行  訂單類型  價格  大小  淨損益  有利波動  不利波動  累積損益  分支
 *
 * The "分支" column is our addition (TV doesn't have branches). It
 * shows which branch each trade belongs to as a kind-color dot + name
 * so the user can scan trades across branches at a glance.
 *
 * Data flow:
 *   Source = SimEngine.getPositionHistory() + getPositions()
 *   Filter = BranchEngine.getAllTrades(activeBranchId)  — applies the
 *            same §2.1 visibility rules used by the chart-side arrows.
 *   Sort   = openedAtBarTs ascending (chronological)
 *   Cumulative P/L is computed in this module (running sum of net P/L).
 *
 * Toggle: 「交易歷史」 button in topbar-right + "T" hotkey when the
 * panel is closed (avoid hijacking T while user types).
 */
(function () {
  const KIND_COLORS = {
    main: '#5a6478',
    exec: '#089981',
    direction: '#ef5350',
    sandbox: '#7d6cbf',
    archived: '#3a3f4b',
  };

  // Spec i18n §3.8 / §4.3: translator alias used throughout this module.
  // Falls back to the key string itself when I18n hasn't loaded yet
  // (early-boot edge — module-init code path that runs synchronously
  // before app.js's await /api/config has completed).
  const t_ = (key, vars) => (window.I18n && window.I18n.t)
    ? window.I18n.t(key, vars)
    : key;

  // Spec §4.4 — only the auto-generated default name "主線" / "Main"
  // is translated. User-renamed branches stay verbatim. Returns a
  // display string suitable for any branch label render in this module
  // (summary footer, modal titles, export choice labels). Null /
  // missing branch returns the localized "Main" too — that's the
  // sensible default for "no active branch yet".
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
    _refreshHandle: null,
    _lastSig: null,

    init() {
      this.el = document.getElementById('sim-history-panel');
      if (!this.el) return;

      // Spec i18n §4.3: re-render on language change so column rows,
      // summary footer, and any open modals reflect the new language.
      // Idempotent guard prevents listener stacking across re-init.
      if (!Panel._i18nWired) {
        Panel._i18nWired = true;
        document.addEventListener('i18n:change', () => {
          // Bypass the row-signature cache so refresh() actually
          // rebuilds the rows even though trade data hasn't changed.
          Panel._lastSig = null;
          try { this.refresh(); } catch (e) {}
        });
      }

      // Move the drawer INTO #chart-area so it sits as a vertical
      // flex sibling of #chart. Opening / closing then shrinks /
      // expands the chart instead of overlaying it (the time axis
      // stays visible). The drawer's `hidden` attribute flips its
      // display:none so closed state takes no layout space.
      const chartArea = document.getElementById('chart-area');
      if (chartArea && this.el.parentNode !== chartArea) {
        chartArea.appendChild(this.el);
      }

      const toggle = document.getElementById('btn-sim-history');
      if (toggle) toggle.addEventListener('click', () => this.toggle());

      // Header toolbar — clear + export buttons (§4o)
      const clearBtn = this.el.querySelector('.sim-history-clear');
      if (clearBtn) clearBtn.addEventListener('click', () => this._onClearClick());
      const exportBtn = this.el.querySelector('.sim-history-export');
      if (exportBtn) exportBtn.addEventListener('click', () => this._onExportClick());

      // Row ✕ buttons — event delegation on tbody (rows are
      // re-rendered every refresh, so per-row listeners would leak).
      const tbody = this.el.querySelector('.sim-history-tbody');
      if (tbody) {
        tbody.addEventListener('click', (e) => {
          const btn = e.target && e.target.closest
            ? e.target.closest('.sim-history-row-delete') : null;
          if (!btn) return;
          e.stopPropagation();
          const posId = parseInt(btn.dataset.posId, 10);
          if (!Number.isFinite(posId)) return;
          this._onRowDelete(posId);
        });
      }

      const close = this.el.querySelector('.sim-history-close');
      if (close) close.addEventListener('click', () => this.close());

      // Subscribe to active-branch changes so the table re-filters
      // immediately when user switches branches.
      if (window.BranchEngine && window.BranchEngine.on) {
        const refresh = () => this.refresh();
        window.BranchEngine.on('activeBranchChanged', refresh);
        window.BranchEngine.on('branchCreated', refresh);
        window.BranchEngine.on('branchDeleted', refresh);
        window.BranchEngine.on('branchRenamed', refresh);
      }

      // Shift+T to toggle the panel (skip when typing in inputs).
      // Plain 't' is captured by app.js's symbol-search letter trigger;
      // requiring Shift avoids the double-fire conflict.
      document.addEventListener('keydown', (e) => {
        const tag = (e.target && e.target.tagName) || '';
        const inForm = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
        if (inForm) return;
        if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
            && (e.key === 'T' || e.code === 'KeyT')) {
          e.preventDefault();
          this.toggle();
        }
      });
    },

    toggle() { this.isOpen ? this.close() : this.open(); },

    open() {
      if (!this.el) return;
      this._snapshotLayout();
      this._applyThirdsLayout();
      this.el.hidden = false;
      this.isOpen = true;
      const tbtn = document.getElementById('btn-sim-history');
      if (tbtn) tbtn.classList.add('active');
      this._resizeAllCharts();
      this._startRefreshLoop();
      this.refresh();
    },

    close() {
      if (!this.el) return;
      this.el.hidden = true;
      this.isOpen = false;
      const tbtn = document.getElementById('btn-sim-history');
      if (tbtn) tbtn.classList.remove('active');
      this._restoreLayout();
      this._resizeAllCharts();
      // Refresh loop stops itself on next tick when isOpen=false.
    },

    /** Snapshot whatever inline `height` the user has on the mini
     *  chart panel right now. Without this, opening the drawer would
     *  clobber the user's hand-tuned mini height (200px default vs.
     *  the larger size they dragged to) and we'd have no way to put
     *  it back on close. */
    _snapshotLayout() {
      const miniPanel = document.getElementById('mini-chart-panel');
      this._layoutSnapshot = {
        miniHeight: (miniPanel && miniPanel.style.height) || '',
      };
    },

    /** When drawer opens with mini also visible, force a 1/3-each
     *  vertical split (main chart / mini / drawer). When mini is
     *  hidden the drawer falls back to its CSS-default height
     *  (`38vh`), giving the main chart ~62vh — that's the original
     *  no-mini behavior, no need to override. */
    _applyThirdsLayout() {
      const miniPanel = document.getElementById('mini-chart-panel');
      const miniVisible = !!(miniPanel && !miniPanel.hidden);
      if (miniVisible) {
        miniPanel.style.height = '33vh';
        this.el.style.height   = '33vh';
      } else {
        this.el.style.height = '';   // CSS default
      }
    },

    /** Restore the user's pre-open layout. Mini panel goes back to
     *  whatever inline height it had before (could be empty string =
     *  CSS default 200px, or whatever pixel value the user dragged
     *  to). Drawer's inline height is cleared regardless — it'll be
     *  hidden anyway, but clearing keeps the next open() clean. */
    _restoreLayout() {
      const miniPanel = document.getElementById('mini-chart-panel');
      if (miniPanel && this._layoutSnapshot) {
        miniPanel.style.height = this._layoutSnapshot.miniHeight;
      }
      this.el.style.height = '';
      this._layoutSnapshot = null;
    },

    /** KLineChart caches its container size. After flex reflow we
     *  must ask both charts to re-measure (one rAF defer so DOM has
     *  reflowed first). Mini chart resize is a no-op when mini is
     *  hidden / not yet initialised. */
    _resizeAllCharts() {
      requestAnimationFrame(() => {
        try { if (window.App && window.App.chart) window.App.chart.resize(); } catch (e) {}
        try {
          if (window.MiniChart && window.MiniChart.chart) {
            window.MiniChart.chart.resize();
          }
        } catch (e) {}
      });
    },

    /** Public hook — called by MiniChart._show / _hide so the layout
     *  reflows correctly when the user toggles mini WHILE the drawer
     *  is already open:
     *  - mini opens with drawer open  → switch to thirds (33/33/33)
     *  - mini closes with drawer open → drawer back to CSS default
     *                                   so main chart picks up the
     *                                   freed space
     *  No-op when drawer is closed; MiniChart's own height logic
     *  takes over in that case. */
    onMiniVisibilityChanged() {
      if (!this.isOpen) return;
      this._applyThirdsLayout();
      this._resizeAllCharts();
    },

    /** rAF poll — same pattern as branch_panel and sim_panel. The sim
     *  engine doesn't emit events for fills yet, so we cheap-poll a
     *  trade signature and re-render only when it changes. Stops when
     *  the panel closes. */
    _startRefreshLoop() {
      if (this._refreshHandle != null) return;
      const tick = () => {
        if (!this.isOpen) {
          this._refreshHandle = null;
          return;
        }
        const eng = window.SimController && window.SimController.engine;
        let sig = '';
        if (eng) {
          const all = eng.getPositionHistory().concat(eng.getPositions());
          let pnlSum = 0;
          for (const p of all) {
            pnlSum += (p.realisedPnL || 0) + (p.unrealisedPnL || 0);
          }
          // include active branch ID so branch switches force re-render
          const aid = window.BranchEngine ? window.BranchEngine.activeBranchId : 'main';
          sig = aid + '|' + all.length + ':' + pnlSum.toFixed(2);
        }
        if (sig !== this._lastSig) {
          this._lastSig = sig;
          this.refresh();
        }
        this._refreshHandle = requestAnimationFrame(tick);
      };
      this._refreshHandle = requestAnimationFrame(tick);
    },

    refresh() {
      if (!this.el) return;
      const eng = window.SimController && window.SimController.engine;
      const Engine = window.BranchEngine;
      const tbody = this.el.querySelector('.sim-history-tbody');
      const summaryEl = this.el.querySelector('.sim-history-summary');
      if (!tbody) return;

      // Pick trade source: branch-filtered if BranchEngine is up,
      // otherwise raw engine state (single-branch fallback).
      let trades = [];
      if (eng) {
        if (Engine && Engine.getAllTrades) {
          trades = Engine.getAllTrades(Engine.activeBranchId);
        } else {
          trades = eng.getPositionHistory().concat(eng.getPositions());
        }
      }
      // Sort chronologically. Ties broken by id so order is stable
      // across re-renders (avoids flicker from Map iteration order).
      trades.sort((a, b) => {
        const ts = (a.openedAtBarTs || 0) - (b.openedAtBarTs || 0);
        if (ts !== 0) return ts;
        return (a.id || 0) - (b.id || 0);
      });

      // Compute running cumulative P/L (gross + unrealised − commission).
      let cum = 0;
      const rows = trades.map((pos, idx) => {
        const realised = Number.isFinite(pos.realisedPnL)   ? pos.realisedPnL   : 0;
        const unreal   = Number.isFinite(pos.unrealisedPnL) ? pos.unrealisedPnL : 0;
        const comm     = Number.isFinite(pos.commissionPaid) ? pos.commissionPaid : 0;
        const netPL    = realised + unreal - comm;
        cum += netPL;
        return { pos, idx, realised, unreal, comm, netPL, cum };
      });

      // Render rows
      if (!rows.length) {
        const lang = (window.I18n && window.I18n.lang) || 'zh';
        const emptyMsg = lang === 'en'
          ? 'No trades yet. Trades on the active branch will show up here.'
          : '尚無交易紀錄。在當前分支下單後，交易會出現在這裡。';
        tbody.innerHTML = `
          <tr class="sim-history-empty">
            <td colspan="11">${emptyMsg}</td>
          </tr>
        `;
      } else {
        tbody.innerHTML = rows.map(r => this._renderTradeRows(r)).join('');
      }

      // Summary footer. Branch name follows spec §4.4 — auto-generated
      // "主線" → translated; user-renamed branches stay verbatim.
      if (summaryEl) {
        const summarySpec = (window.SimController && window.SimController.spec) || {};
        const summaryCur = summarySpec.currency || 'USD';
        const fmtPL = (n) => {
          const sign = n > 0 ? '+' : (n < 0 ? '−' : '');
          return `${sign}${Math.abs(n).toFixed(2)} ${summaryCur}`;
        };
        const cls = cum > 0 ? 'pos' : (cum < 0 ? 'neg' : 'zero');
        const branch = Engine && Engine.getActiveBranch ? Engine.getActiveBranch() : null;
        const branchName = displayBranchName(branch);
        const lang = (window.I18n && window.I18n.lang) || 'zh';
        const tradesWord  = lang === 'en' ? 'trades' : '筆交易';
        const cumPnlLabel = lang === 'en' ? 'Cumulative P&L' : '累積淨損益';
        summaryEl.innerHTML = `
          <span class="sim-history-summary-label">${escapeHtml(branchName)} · ${rows.length} ${tradesWord}</span>
          <span class="sim-history-summary-total ${cls}">${cumPnlLabel} ${fmtPL(cum)}</span>
        `;
      }
    },

    /** Build one trade as a single <tr> with two stacked <div>s per
     *  cell (出場 on top, 進場 on bottom). This lays out cleanly without
     *  rowspan tricks — every cell shares the same row height, so all
     *  columns vertically align line-by-line.
     *
     *  Per-leg columns (date, order type, price) show different content
     *  on each line. Aggregate columns (size, P/L, MFE, MAE, cumulative)
     *  show value-on-top + percentage-below — matches TradingView.
     *  分支 column is single-line, vertically centered. */
    _renderTradeRows(r) {
      const { pos, idx, netPL, cum } = r;
      const eng = window.SimController && window.SimController.engine;
      const Engine = window.BranchEngine;

      const sideText = pos.side === 'long' ? t_('sim.posSideLong') : t_('sim.posSideShort');
      const sideClass = pos.side === 'long' ? 'long' : 'short';

      // Entry order info
      const entryOrderId = pos.entryOrderIds && pos.entryOrderIds[0];
      const entryOrder = entryOrderId != null && eng && eng.getOrder
        ? eng.getOrder(entryOrderId) : null;
      const entryTs = (entryOrder && entryOrder.filledAtBarTs) || pos.openedAtBarTs;
      const entryPrice = (entryOrder && entryOrder.fillPrice) || pos.avgEntryPrice;
      const entryTypeLabel = orderTypeLabel(entryOrder, 'entry');

      // Exit info (if closed). Open positions render the "Open / 持倉中"
      // placeholder on the exit line.
      const isClosed = pos.closedAtBarTs != null;
      let exitTs = null, exitPrice = null, exitTypeLabel = '—';
      if (isClosed && pos.exitOrderIds && pos.exitOrderIds.length) {
        const exitOrderId = pos.exitOrderIds[pos.exitOrderIds.length - 1];
        const exitOrder = eng && eng.getOrder ? eng.getOrder(exitOrderId) : null;
        if (exitOrder) {
          exitTs = exitOrder.filledAtBarTs;
          exitPrice = exitOrder.fillPrice;
          exitTypeLabel = orderTypeLabel(exitOrder, 'exit', pos);
        }
      }

      // Notional, % change, MFE/MAE/cumulative percentages.
      // tradeQty = lifetime entered qty. pos.qty is the *remaining*
      // open qty and is set to 0 the moment the position fully
      // closes (engine.processBar line ~440), so reading it directly
      // showed "0" for every closed trade in 大小. Older saved
      // positions without `entryQty` fall back to pos.qty.
      const spec = (window.SimController && window.SimController.spec) || {};
      const pv  = spec.pointValue || 1;
      const lot = spec.lotSize    || 1;
      const tradeQty = (pos.entryQty != null) ? pos.entryQty : pos.qty;
      const notional = entryPrice * tradeQty * pv * lot;

      let netPctSigned = 0;
      if (isClosed && Number.isFinite(exitPrice) && entryPrice > 0) {
        const dir = pos.side === 'long' ? 1 : -1;
        netPctSigned = ((exitPrice - entryPrice) / entryPrice) * 100 * dir;
      }
      const netPctDisplay = isClosed
        ? `${netPctSigned >= 0 ? '+' : ''}${netPctSigned.toFixed(2)}%`
        : '—';

      const mfe = pos.mfe || 0;
      const mae = pos.mae || 0;
      const account = eng && eng.getAccount ? eng.getAccount() : null;
      const startingBalance = (account && account.startingBalance) || 50000;
      const mfePct = notional > 0 ? (mfe / notional) * 100 : 0;
      const maePct = notional > 0 ? (mae / notional) * 100 : 0;
      const cumPct = startingBalance > 0 ? (cum / startingBalance) * 100 : 0;

      // Branch attribution
      const branchId = pos.branchId || 'main';
      const branch = Engine && Engine.getBranch ? Engine.getBranch(branchId) : null;
      const branchName = branch ? branch.name : branchId;
      const branchKind = branch ? branch.kind : 'main';
      const branchColor = KIND_COLORS[branchKind] || '#888';

      // Format helpers — currency follows the active symbol's spec
      // (read once at the top so all 5 P&L cells stay consistent).
      const cur = (spec && spec.currency) || 'USD';
      const fmtPx = (p) => Number.isFinite(p) ? p.toFixed(2) : '—';
      const fmtPL = (n) => {
        const s = n > 0 ? '+' : (n < 0 ? '−' : '');
        return `${s}${Math.abs(n).toFixed(0)}`;
      };
      const fmtPctSigned = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
      // Trade history needs year-prefixed timestamps so MM/DD across
      // multi-year backtests stays unambiguous (different from panel
      // meta / fork tooltip which stick with short form for layout).
      const fmtTs = window.formatBarTimeFull || window.formatBarTime
                    || ((t) => String(t));

      const netClass = netPL > 0 ? 'pos' : (netPL < 0 ? 'neg' : 'zero');
      const cumClass = cum > 0 ? 'pos' : (cum < 0 ? 'neg' : 'zero');

      // User-confirmed order (corrected from previous turn):
      //   進場 / Entry on TOP line, 出場 / Exit on BOTTOM line.
      const entryWord = t_('history.entryLabel');
      const exitWord  = t_('history.exitLabel');
      const holdingWord = t_('history.holdingPos');
      const exitTimeStr  = isClosed ? `${exitWord}  ${fmtTs(exitTs)}`  : `${exitWord}  ${holdingWord}`;
      const exitTypeStr  = isClosed ? exitTypeLabel : '—';
      const exitPriceStr = isClosed ? `${fmtPx(exitPrice)}` : '—';

      return `
        <tr class="sim-history-trade trade-${sideClass}">
          <td class="sim-history-num">
            <div class="line-top idx">${idx + 1}</div>
            <div class="line-bot side ${sideClass}">${sideText}</div>
          </td>
          <td class="sim-history-time">
            <div class="line-top">${entryWord}  ${escapeHtml(fmtTs(entryTs))}</div>
            <div class="line-bot">${escapeHtml(exitTimeStr)}</div>
          </td>
          <td class="sim-history-ordertype">
            <div class="line-top">${escapeHtml(entryTypeLabel)}</div>
            <div class="line-bot">${escapeHtml(exitTypeStr)}</div>
          </td>
          <td class="sim-history-price">
            <div class="line-top">${escapeHtml(fmtPx(entryPrice))}</div>
            <div class="line-bot">${escapeHtml(exitPriceStr)}</div>
          </td>
          <td class="sim-history-size">
            <div class="line-top">${tradeQty}</div>
            <div class="line-bot notional">${formatNotional(notional)} <span class="unit">${escapeHtml(cur)}</span></div>
          </td>
          <td class="sim-history-pl ${netClass}">
            <div class="line-top">${fmtPL(netPL)} <span class="unit">${escapeHtml(cur)}</span></div>
            <div class="line-bot pct">${escapeHtml(netPctDisplay)}</div>
          </td>
          <td class="sim-history-mfe">
            <div class="line-top">${fmtPL(mfe)} <span class="unit">${escapeHtml(cur)}</span></div>
            <div class="line-bot pct">${escapeHtml(fmtPctSigned(mfePct))}</div>
          </td>
          <td class="sim-history-mae">
            <div class="line-top">${fmtPL(mae)} <span class="unit">${escapeHtml(cur)}</span></div>
            <div class="line-bot pct">${escapeHtml(fmtPctSigned(maePct))}</div>
          </td>
          <td class="sim-history-cum ${cumClass}">
            <div class="line-top">${fmtPL(cum)} <span class="unit">${escapeHtml(cur)}</span></div>
            <div class="line-bot pct">${escapeHtml(fmtPctSigned(cumPct))}</div>
          </td>
          <td class="sim-history-branch">
            <span class="sim-history-branch-dot" style="background:${branchColor}"></span>
            <span class="sim-history-branch-name">${escapeHtml(branchName)}</span>
          </td>
          <td class="sim-history-row-action">
            <button type="button" class="sim-history-row-delete"
                    data-pos-id="${pos.id}" title="${escapeHtml(t_('history.deleteRowTooltip'))}">✕</button>
          </td>
        </tr>
      `;
    },

    // ---------------- §4o: row delete / clear branch / export -------

    /** Single trade delete via row ✕. Pops a 普通 confirm modal
     *  (user revised the spec — no longer無 modal). SimController.deleteTrade
     *  triggers markDirty + persist + UI refresh. */
    async _onRowDelete(positionId) {
      const eng = window.SimController && window.SimController.engine;
      if (!eng) return;
      const pos = (eng.getPositions().concat(eng.getPositionHistory()))
        .find(p => p.id === positionId);
      const summary = pos ? this._tradeSummaryText(pos) : `#${positionId}`;
      const lang = (window.I18n && window.I18n.lang) || 'zh';
      // Body text isn't in spec §3.8 — translate inline. zh original
      // first, then a faithful en equivalent.
      const bodyTail = lang === 'en'
        ? 'Removing this trade will reverse the related orders and roll back its balance impact. This action cannot be undone.'
        : '刪除後此筆交易與相關訂單會被移除，且帳戶餘額影響會反沖。此動作無法復原。';
      const ok = await this._confirm({
        title: t_('history.dlgDeleteTitle'),
        body: `${summary}\n${bodyTail}`,
        primaryLabel: t_('history.dlgDeletePrimary'),
        primaryClass: 'danger',
      });
      if (!ok) return;
      if (window.SimController && window.SimController.deleteTrade) {
        window.SimController.deleteTrade(positionId);
      }
    },

    /** Compact one-line description of a trade for confirm modals.
     *  Uses entryQty (lifetime entered) instead of qty (remaining
     *  open) so closed trades show the actual size, not 0. */
    _tradeSummaryText(pos) {
      const sideText = pos.side === 'long' ? t_('sim.posSideLong') : t_('sim.posSideShort');
      const fmtPx = (p) => Number.isFinite(p) ? p.toFixed(2) : '—';
      const entry = Number.isFinite(pos.avgEntryPrice) ? pos.avgEntryPrice : null;
      const closed = pos.closedAtBarTs != null;
      const qty = (pos.entryQty != null) ? pos.entryQty : pos.qty;
      const suffix = closed ? t_('history.closedSuffix') : t_('history.openSuffix');
      return `${sideText} ${qty} @ ${fmtPx(entry)}${suffix}`;
    },

    /** 「清除本分支」 — strong action,普通 confirm modal per the
     *  user's pick. Removes every trade / order on the active branch
     *  and reverses the balance impact. */
    async _onClearClick() {
      const Engine = window.BranchEngine;
      const branch = Engine && Engine.getActiveBranch
        ? Engine.getActiveBranch() : null;
      const branchName = displayBranchName(branch);
      const trades = (Engine && Engine.getOwnTrades && branch)
        ? Engine.getOwnTrades(branch.id) : [];
      const lang = (window.I18n && window.I18n.lang) || 'zh';
      if (!trades.length) {
        // No-op — nothing to clear. Show a brief notice instead of
        // popping a confirm modal for an empty operation.
        const empty = lang === 'en'
          ? `No trades to clear on "${branchName}".`
          : `「${branchName}」 沒有交易可清除。`;
        this._toast(empty);
        return;
      }
      // Body text not in spec §3.8 — inline translation.
      const body = lang === 'en'
        ? `This will delete ${trades.length} trade(s) and all pending orders on this branch, and reverse the balance impact. This action cannot be undone.`
        : `這會刪除這個分支底下的 ${trades.length} 筆交易紀錄、`
          + `所有未成交訂單，並把分支的餘額影響反沖回帳戶。此動作無法復原。`;
      const ok = await this._confirm({
        title: t_('history.dlgClearTitle', { name: branchName }),
        body,
        primaryLabel: t_('history.dlgClearPrimary'),
        primaryClass: 'danger',
      });
      if (!ok) return;
      if (window.SimController && window.SimController.clearActiveBranch) {
        window.SimController.clearActiveBranch();
      }
    },

    /** 「下載」 — pop a 3-option modal:
     *    1. 主圖（active branch）
     *    2. 副圖（mini branch）
     *    3. 全部分支（合併、每分支一個 worksheet）
     *  Then build the .xlsx via SheetJS and trigger download. */
    async _onExportClick() {
      if (typeof window.XLSX === 'undefined') {
        this._toast(t_('history.toastSheetjsLoading'));
        return;
      }
      const Engine = window.BranchEngine;
      const active  = Engine && Engine.getActiveBranch
        ? Engine.getActiveBranch() : null;
      const miniId  = Engine && Engine.miniBranchId;
      const miniBr  = miniId && Engine && Engine.getBranch
        ? Engine.getBranch(miniId) : null;
      const branches = Engine && Engine.getBranches
        ? Engine.getBranches() : [];

      const lang = (window.I18n && window.I18n.lang) || 'zh';
      // Choice labels mix branch names (user data, never translated)
      // with descriptive prefixes that DO translate. Spec §3.8 covers
      // the multi-sheet + per-branch entries; the single-branch
      // "主圖 (X) / 副圖 (X)" labels get inline translations since
      // they're our own composition, not TV terms.
      const choices = [];
      if (active) {
        const activeName = displayBranchName(active);
        choices.push({
          key: 'active',
          label: lang === 'en' ? `Main (${activeName})` : `主圖（${activeName}）`,
          desc:  lang === 'en'
            ? `Export the active main-pane branch's trades`
            : `匯出當前主圖分支的交易紀錄`,
        });
      }
      if (miniBr) {
        const miniName = displayBranchName(miniBr);
        choices.push({
          key: 'mini',
          label: lang === 'en' ? `Mini (${miniName})` : `副圖（${miniName}）`,
          desc:  lang === 'en'
            ? `Export the mini-pane branch's trades`
            : `匯出副圖分支的交易紀錄`,
        });
      }
      if (active && miniBr) {
        choices.push({
          key: 'both',
          label: t_('history.dlgExportMulti'),
          desc:  t_('history.dlgExportMultiDesc'),
        });
      }
      if (branches.length) {
        const allLabel = lang === 'en'
          ? `All branches (${branches.length} sheets)`
          : `全部分支（${branches.length} 個工作表）`;
        choices.push({
          key: 'all',
          label: allLabel,
          desc:  t_('history.dlgExportPerBranchDesc'),
        });
      }
      if (!choices.length) {
        this._toast(t_('history.toastNoBranches'));
        return;
      }
      const pick = await this._chooseExport(choices);
      if (!pick) return;

      const wb = window.XLSX.utils.book_new();
      const stamp = this._fileStamp();
      let filename = `trades-${stamp}.xlsx`;

      const addBranchSheet = (branch) => {
        const trades = this._collectTradesForBranch(branch.id);
        if (!trades.length) {
          // Still create the sheet so the user sees the empty branch
          // exists — single header row.
          const ws = window.XLSX.utils.aoa_to_sheet([this._exportHeader()]);
          window.XLSX.utils.book_append_sheet(wb, ws,
            this._sheetName(branch.name));
          return;
        }
        const aoa = [this._exportHeader()].concat(
          trades.map((t, idx) => this._exportRow(t, idx, trades)));
        const ws = window.XLSX.utils.aoa_to_sheet(aoa);
        window.XLSX.utils.book_append_sheet(wb, ws,
          this._sheetName(branch.name));
      };

      if (pick.key === 'active') {
        addBranchSheet(active);
        filename = `trades-${active.name}-${stamp}.xlsx`;
      } else if (pick.key === 'mini') {
        addBranchSheet(miniBr);
        filename = `trades-${miniBr.name}-${stamp}.xlsx`;
      } else if (pick.key === 'both') {
        addBranchSheet(active);
        addBranchSheet(miniBr);
        filename = `trades-main+mini-${stamp}.xlsx`;
      } else if (pick.key === 'all') {
        // Main first (spec convention), then everything else by
        // creation time.
        const ordered = branches.slice().sort((a, b) => {
          if (a.kind === 'main') return -1;
          if (b.kind === 'main') return 1;
          return (a.createdAt || 0) - (b.createdAt || 0);
        });
        for (const br of ordered) addBranchSheet(br);
        filename = `trades-all-${stamp}.xlsx`;
      }
      window.XLSX.writeFile(wb, filename);
    },

    /** Collect trades for a single branch, sorted chronologically.
     *  Reuses the same source-of-truth path as `refresh`: ALL trades
     *  visible to that branch via attribution (own + inherited). */
    _collectTradesForBranch(branchId) {
      const Engine = window.BranchEngine;
      let trades = [];
      if (Engine && Engine.getAllTrades) {
        trades = Engine.getAllTrades(branchId);
      } else {
        const eng = window.SimController && window.SimController.engine;
        if (eng) trades = eng.getPositionHistory().concat(eng.getPositions());
      }
      trades.sort((a, b) => {
        const ts = (a.openedAtBarTs || 0) - (b.openedAtBarTs || 0);
        if (ts !== 0) return ts;
        return (a.id || 0) - (b.id || 0);
      });
      return trades;
    },

    _exportHeader() {
      // Spec i18n §3.8 note: TradingView's import path expects English
      // headers. With uiLang=en the entire header row uses the
      // history.csv.* keys (English column names matching the TV
      // strategy-tester format); zh keeps the readable Traditional
      // Chinese labels.
      return [
        t_('history.csv.tradeNum'),
        t_('history.csv.side'),
        t_('history.csv.entryTime'),
        t_('history.csv.entryType'),
        t_('history.csv.entryPrice'),
        t_('history.csv.exitTime'),
        t_('history.csv.exitType'),
        t_('history.csv.exitPrice'),
        t_('history.csv.qty'),
        t_('history.csv.notional'),
        t_('history.csv.netPnlUsd'),
        t_('history.csv.netPnlPct'),
        t_('history.csv.runupUsd'),
        t_('history.csv.drawdownUsd'),
        t_('history.csv.cumPnlUsd'),
        t_('history.colBranch'),
      ];
    },

    _exportRow(pos, idx, allTrades) {
      const eng = window.SimController && window.SimController.engine;
      const Engine = window.BranchEngine;
      const spec = (window.SimController && window.SimController.spec) || {};
      const pv  = spec.pointValue || 1;
      const lot = spec.lotSize    || 1;
      // Cumulative — recompute against allTrades up to and including idx.
      let cum = 0;
      for (let i = 0; i <= idx; i++) {
        const p = allTrades[i];
        const r = Number.isFinite(p.realisedPnL)   ? p.realisedPnL   : 0;
        const u = Number.isFinite(p.unrealisedPnL) ? p.unrealisedPnL : 0;
        const c = Number.isFinite(p.commissionPaid) ? p.commissionPaid : 0;
        cum += (r + u - c);
      }
      const realised = Number.isFinite(pos.realisedPnL)   ? pos.realisedPnL   : 0;
      const unreal   = Number.isFinite(pos.unrealisedPnL) ? pos.unrealisedPnL : 0;
      const comm     = Number.isFinite(pos.commissionPaid) ? pos.commissionPaid : 0;
      const netPL    = realised + unreal - comm;
      const entryOrderId = pos.entryOrderIds && pos.entryOrderIds[0];
      const entryOrder = entryOrderId != null && eng && eng.getOrder
        ? eng.getOrder(entryOrderId) : null;
      const entryTs    = (entryOrder && entryOrder.filledAtBarTs) || pos.openedAtBarTs;
      const entryPrice = (entryOrder && entryOrder.fillPrice) || pos.avgEntryPrice;
      const isClosed = pos.closedAtBarTs != null;
      let exitTs = null, exitPrice = null, exitTypeLabel = '';
      if (isClosed && pos.exitOrderIds && pos.exitOrderIds.length) {
        const exitOrderId = pos.exitOrderIds[pos.exitOrderIds.length - 1];
        const exitOrder = eng && eng.getOrder ? eng.getOrder(exitOrderId) : null;
        if (exitOrder) {
          exitTs = exitOrder.filledAtBarTs;
          exitPrice = exitOrder.fillPrice;
          exitTypeLabel = orderTypeLabel(exitOrder, 'exit', pos);
        }
      }
      const tradeQty = (pos.entryQty != null) ? pos.entryQty : pos.qty;
      const notional = (entryPrice || 0) * tradeQty * pv * lot;
      let netPct = 0;
      if (isClosed && Number.isFinite(exitPrice) && entryPrice > 0) {
        const dir = pos.side === 'long' ? 1 : -1;
        netPct = ((exitPrice - entryPrice) / entryPrice) * 100 * dir;
      }
      const branchId = pos.branchId || 'main';
      const br = Engine && Engine.getBranch ? Engine.getBranch(branchId) : null;
      const branchName = br ? br.name : branchId;
      // xlsx export uses the same year-prefixed format as the on-
      // screen table so the spreadsheet is self-contained — readers
      // don't need to know which year's session it came from.
      const fmtTs = window.formatBarTimeFull || window.formatBarTime
                    || ((t) => t ? new Date(t).toISOString() : '');
      return [
        idx + 1,
        pos.side === 'long' ? t_('sim.posSideLong') : t_('sim.posSideShort'),
        entryTs ? fmtTs(entryTs) : '',
        orderTypeLabel(entryOrder, 'entry'),
        Number.isFinite(entryPrice) ? Number(entryPrice.toFixed(2)) : '',
        isClosed && exitTs ? fmtTs(exitTs) : (isClosed ? '' : t_('history.holdingPos')),
        isClosed ? exitTypeLabel : '',
        isClosed && Number.isFinite(exitPrice) ? Number(exitPrice.toFixed(2)) : '',
        tradeQty,
        Number(notional.toFixed(2)),
        Number(netPL.toFixed(2)),
        isClosed ? Number(netPct.toFixed(2)) : '',
        Number((pos.mfe || 0).toFixed(2)),
        Number((pos.mae || 0).toFixed(2)),
        Number(cum.toFixed(2)),
        branchName,
      ];
    },

    /** xlsx sheet names: max 31 chars, no `\ / ? * [ ]` per Excel
     *  rules, must be unique within the workbook. We delegate
     *  uniqueness to SheetJS (it'll suffix a digit on collision).
     *  Spec §3.8 note: en fallback "Branch", zh fallback "分支". */
    _sheetName(name) {
      const fallback = t_('history.csv.sheetBranchFallback');
      const cleaned = String(name || fallback).replace(/[\\/\?\*\[\]]/g, '_');
      return cleaned.slice(0, 31) || fallback;
    },

    _fileStamp() {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
           + `-${pad(d.getHours())}${pad(d.getMinutes())}`;
    },

    // ---------------- Modal helpers (普通 confirm + export-pick) ----
    //
    // Modals are non-blocking: backdrop is transparent (the user
    // wanted to keep seeing the chart). Click outside the card —
    // INCLUDING on the chart canvas underneath — closes the modal
    // (resolves cancel). The backdrop spans the viewport with
    // pointer-events: auto so it captures those outside clicks
    // regardless of which page element the user actually targets.
    // The card itself has a draggable header (cursor:move, mousedown
    // → translate) and an ✕ button for explicit close.

    /** Build the shared modal scaffold. Caller fills `content`.
     *  Returns a `dispose` fn the caller MUST invoke on close so
     *  the drag listeners on `document` get removed. Otherwise
     *  every open-close cycle leaks a pair of mousemove/mouseup
     *  listeners. */
    _buildModal({ title }) {
      const root = this._modalRoot();
      const closeLabel = t_('common.close');
      root.innerHTML = `
        <div class="sim-modal-backdrop"></div>
        <div class="sim-modal-card" role="dialog" aria-modal="false">
          <header class="sim-modal-header">
            <span class="sim-modal-title">${escapeHtml(title)}</span>
            <button type="button" class="sim-modal-close" title="${escapeHtml(closeLabel)}" aria-label="${escapeHtml(closeLabel)}">✕</button>
          </header>
          <div class="sim-modal-content"></div>
        </div>
      `;
      const card    = root.querySelector('.sim-modal-card');
      const header  = root.querySelector('.sim-modal-header');
      const content = root.querySelector('.sim-modal-content');
      const closeBtn = root.querySelector('.sim-modal-close');
      const backdrop = root.querySelector('.sim-modal-backdrop');
      const detachDrag = this._attachModalDrag(card, header);
      return {
        root, card, header, content, closeBtn, backdrop,
        dispose: () => { detachDrag(); },
      };
    },

    /** Wire mousedown-on-header → drag-to-translate. Skip the ✕
     *  button so close-click doesn't start a drag. The card is
     *  centered via CSS transform initially; first drag flips to
     *  inline left/top + transform: none (matches makePanelDraggable
     *  in drawing.js). Returns a detach fn — call on modal close
     *  to remove the document-level listeners. */
    _attachModalDrag(card, header) {
      let dragging = false, sx, sy, sLeft, sTop;
      const onDown = (e) => {
        if (e.button !== 0) return;
        if (e.target.closest && e.target.closest('button')) return;
        const r = card.getBoundingClientRect();
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        sLeft = r.left;  sTop = r.top;
        card.style.left = sLeft + 'px';
        card.style.top  = sTop  + 'px';
        card.style.transform = 'none';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!dragging) return;
        card.style.left = (sLeft + (e.clientX - sx)) + 'px';
        card.style.top  = (sTop  + (e.clientY - sy)) + 'px';
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
      };
      header.addEventListener('mousedown', onDown);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
      return () => {
        header.removeEventListener('mousedown', onDown);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
    },

    _confirm({ title, body, primaryLabel,
               primaryClass = '' }) {
      return new Promise((resolve) => {
        if (primaryLabel == null) primaryLabel = t_('common.confirm');
        const m = this._buildModal({ title });
        m.content.innerHTML = `
          <div class="sim-modal-body">${escapeHtml(body)}</div>
          <div class="sim-modal-actions">
            <button type="button" class="sim-modal-cancel">${escapeHtml(t_('common.cancel'))}</button>
            <button type="button" class="sim-modal-primary ${primaryClass}">
              ${escapeHtml(primaryLabel)}
            </button>
          </div>
        `;
        const close = (val) => {
          m.dispose();
          m.root.innerHTML = '';
          m.root.hidden = true;
          document.removeEventListener('keydown', onKey, true);
          resolve(val);
        };
        const onKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); close(false); }
          else if (e.key === 'Enter') { e.preventDefault(); close(true); }
        };
        m.backdrop.addEventListener('click', () => close(false));
        m.closeBtn.addEventListener('click', () => close(false));
        m.content.querySelector('.sim-modal-cancel')
          .addEventListener('click', () => close(false));
        m.content.querySelector('.sim-modal-primary')
          .addEventListener('click', () => close(true));
        document.addEventListener('keydown', onKey, true);
        m.root.hidden = false;
      });
    },

    _chooseExport(choices) {
      return new Promise((resolve) => {
        const m = this._buildModal({ title: t_('history.dlgExportTitle') });
        const items = choices.map((c, i) => `
          <button type="button" class="sim-modal-choice"
                  data-key="${escapeHtml(c.key)}"
                  ${i === 0 ? 'autofocus' : ''}>
            <div class="sim-modal-choice-label">${escapeHtml(c.label)}</div>
            <div class="sim-modal-choice-desc">${escapeHtml(c.desc)}</div>
          </button>
        `).join('');
        // Body prompt line "選擇要匯出的範圍：" not in spec §3.8 — inline.
        const lang = (window.I18n && window.I18n.lang) || 'zh';
        const promptText = lang === 'en' ? 'Choose what to export:' : '選擇要匯出的範圍：';
        m.content.innerHTML = `
          <div class="sim-modal-body">${escapeHtml(promptText)}</div>
          <div class="sim-modal-choices">${items}</div>
          <div class="sim-modal-actions">
            <button type="button" class="sim-modal-cancel">${escapeHtml(t_('common.cancel'))}</button>
          </div>
        `;
        const close = (val) => {
          m.dispose();
          m.root.innerHTML = '';
          m.root.hidden = true;
          document.removeEventListener('keydown', onKey, true);
          resolve(val);
        };
        const onKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); close(null); }
        };
        m.backdrop.addEventListener('click', () => close(null));
        m.closeBtn.addEventListener('click', () => close(null));
        m.content.querySelector('.sim-modal-cancel')
          .addEventListener('click', () => close(null));
        m.content.querySelectorAll('.sim-modal-choice').forEach((btn) => {
          btn.addEventListener('click', () => {
            const key = btn.dataset.key;
            const c = choices.find((x) => x.key === key);
            close(c || null);
          });
        });
        document.addEventListener('keydown', onKey, true);
        m.root.hidden = false;
      });
    },

    _modalRoot() {
      let root = document.getElementById('sim-history-modal-root');
      if (!root) {
        root = document.createElement('div');
        root.id = 'sim-history-modal-root';
        root.hidden = true;
        document.body.appendChild(root);
      }
      return root;
    },

    /** Tiny ephemeral toast for non-blocking warnings ("xlsx not loaded
     *  yet", "no trades to clear"). Auto-dismisses after 2.5s. */
    _toast(msg) {
      let host = document.getElementById('sim-history-toast');
      if (!host) {
        host = document.createElement('div');
        host.id = 'sim-history-toast';
        document.body.appendChild(host);
      }
      host.textContent = msg;
      host.classList.add('show');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => host.classList.remove('show'), 2500);
    },
  };

  /** Map a SimOrder + leg into a TradingView-ish display label. */
  function orderTypeLabel(order, leg, pos) {
    if (!order) return '—';
    const sideWord = order.side === 'buy' ? 'Buy' : 'Sell';
    const typeWord = ({
      market:     'market order',
      limit:      'limit order',
      stop:       'stop order',
      stop_limit: 'stop-limit order',
    })[order.type] || order.type;
    // Bracket children get a TV-style "Bracket Take Profit / Stop Loss".
    if (order.bracketParentId && leg === 'exit' && pos) {
      if (pos.closeReason === 'tp_hit') return 'Bracket Take Profit';
      if (pos.closeReason === 'sl_hit') return 'Bracket Stop Loss';
    }
    // Reverse-trade labels — the same engine order id is shared
    // between (a) the closing leg of pos_old (closeReason='reverse'),
    // and (b) the entry leg of pos_new (order.isReverse === true).
    // Render distinct labels so the user can tell ↕-driven events
    // apart from manual market exits / fresh entries.
    if (leg === 'exit' && pos && pos.closeReason === 'reverse') return t_('history.exitReasonReverse');
    if (leg === 'entry' && order.isReverse) return t_('history.entryReasonReverse');
    return `${sideWord} ${typeWord}`;
  }

  function formatNotional(n) {
    if (!Number.isFinite(n)) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + ' K';
    return n.toFixed(2);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;',
      '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  window.SimHistory = Panel;
})();
