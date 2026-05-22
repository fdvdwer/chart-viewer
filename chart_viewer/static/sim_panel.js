/**
 * sim_panel.js — Right-side trading panel (step 2).
 *
 * Owns:
 *   - The SimEngine instance for the current chart symbol
 *   - The DOM panel UI (tabs, inputs, bid/ask, CTAs, position view,
 *     pending-order list)
 *   - The bar feed: in normal mode the latest loaded bar; in replay
 *     mode the in-progress bar at cursorBarIdx (replay.js will call
 *     SimController.onReplayTick after each tick — wired in step 7;
 *     for step 2 a fallback "fill against latest bar on placement"
 *     is enough to make the panel feel responsive).
 *
 * Step 2 scope (per spec): market + limit + stop + stop_limit entries,
 * NO bracket TP/SL yet, NO drag-to-modify. Pending orders show as a
 * horizontal line on the chart (sim_overlays.js).
 */
(function () {
  // ------------------------------------------------------------------
  // SimController — single SimEngine instance + bar-feed integration.
  // Other modules (sim_overlays.js, sim_history.js later) read engine
  // state via this object.
  // ------------------------------------------------------------------
  const Controller = {
    engine: null,
    spec: null,
    // Persistence context — set by `loadForLayout` (called from app.js
    // after the layout's currentSymbol is known). Once both are set,
    // mutations (placeOrder, cancelOrder, replay tick fills, etc.) flag
    // the engine state dirty and a debounced PUT writes
    // `user_data/layouts/<id>/sim/<symbol>.json`.
    _layoutId: null,
    _symbol:   null,
    _saveTimer: null,
    _saveDelayMs: 250,        // matches drawings / replay
    _saving: false,           // in-flight guard so we don't fire two
                              // overlapping PUTs for the same blob
    _dirty: false,

    init() {
      const symbol = (window.App && window.App.currentSymbol) || 'NQ';
      this.spec = window.SymbolSpecs.getSpec(symbol);
      const accountSize = (window.PositionConfig && window.PositionConfig.account_size) || 50000;
      this.engine = window.SimEngine.create({ spec: this.spec, accountSize });

      // branching-replay-spec §2.1: when the user switches active
      // branch, trade arrows / entry-exit overlays need to re-filter
      // (sibling-timeline trades hide; inherited trades fade-in with
      // alpha). _syncTradeArrows in sim_overlays.js reads
      // BranchEngine.activeBranchId on every call, so triggering a
      // sync here is enough — no engine-level changes needed.
      if (window.BranchEngine && window.BranchEngine.on) {
        const triggerOverlaySync = () => {
          if (window.SimOverlays && window.SimOverlays.sync) {
            window.SimOverlays.sync();
          }
        };
        window.BranchEngine.on('activeBranchChanged', triggerOverlaySync);
        // Mini-branch changes need a sync too — sim_overlays now
        // renders mini-chart trade arrows + duration lines, which
        // are pinned to BranchEngine.miniBranchId. Without this
        // hook the mini chart only refreshes when the user happens
        // to trigger a sync via some other path (placeOrder etc.).
        window.BranchEngine.on('miniBranchChanged', triggerOverlaySync);
      }
      // When the user edits a symbol's contract spec via the new
      // Symbol Settings modal, re-pull our cached spec for the
      // current symbol so subsequent P&L / sizing math uses the
      // updated values. Idempotent guard prevents listener stacking
      // on hot-reload. Closed positions in history don't recompute —
      // their P&L was committed at close time (documented in
      // panel.symspec.warnHistoryNote).
      if (!Controller._specWired) {
        Controller._specWired = true;
        document.addEventListener('symbol_specs:changed', () => {
          // SimEngine captures spec by closure; symbol_specs.js
          // mutates the existing spec object in place, so this.spec
          // (same reference) auto-reflects the new values without
          // engine recreation. We just re-trigger the panel + history
          // renders so cached display strings (currency suffix etc.)
          // refresh.
          const sym = (window.App && window.App.currentSymbol) || 'NQ';
          this.spec = window.SymbolSpecs.getSpec(sym);
          if (Panel && Panel.refresh) Panel.refresh();
          if (Overlays && Overlays.sync) Overlays.sync();
          if (window.SimHistory && window.SimHistory.refresh) {
            window.SimHistory.refresh();
          }
        });
      }
    },

    // ---------------- Server persistence -----------------------------
    //
    // Backend endpoints: GET / PUT `/api/sim?layout=&symbol=`. Body is
    // whatever `engine.serialize()` returns (schema v1: balance,
    // pendingOrders, orderHistory, positions, positionHistory, lastBar).
    //
    // Flow:
    //   - app.js boot: openLayout → SimController.loadForLayout(id, sym)
    //     → fetch GET, restore engine, then mark loaded.
    //   - mutation: placeOrder / cancelOrder / fill in tick →
    //     _markDirty → debounced _flush.
    //   - layout switch: openLayout calls flushNow on outgoing layout
    //     before swapping context.
    //
    // Errors are warned-and-swallowed: a failed PUT just leaves the
    // most recent state un-saved; next mutation re-triggers the
    // debounce and we try again. We don't surface failures to the
    // user — same policy as drawings / replay.

    async loadForLayout(layoutId, symbol) {
      // Flush any pending save against the OLD context first so we
      // don't lose work on layout switch.
      await this.flushNow();
      this._layoutId = layoutId || null;
      this._symbol   = symbol || null;
      // Fresh engine to avoid bleeding state between layouts.
      const accountSize = (window.PositionConfig && window.PositionConfig.account_size) || 50000;
      this.spec = window.SymbolSpecs.getSpec(symbol || 'NQ');
      this.engine = window.SimEngine.create({ spec: this.spec, accountSize });
      if (!layoutId || !symbol) {           // no context → empty engine
        this._dirty = false;
        Panel && Panel.refresh && Panel.refresh();
        Overlays && Overlays.sync && Overlays.sync();
        return;
      }
      try {
        const r = await fetch(
          `/api/sim?layout=${encodeURIComponent(layoutId)}&symbol=${encodeURIComponent(symbol)}`,
          { cache: 'no-store' });
        if (r.ok) {
          const snap = await r.json();
          if (snap && this.engine.restore && this.engine.restore(snap)) {
            // Successfully restored — update dependent UI.
          }
        }
      } catch (e) {
        console.warn('[sim] loadForLayout fetch failed', e);
      }
      this._dirty = false;
      Panel && Panel.refresh && Panel.refresh();
      Overlays && Overlays.sync && Overlays.sync();
    },

    /** Mark the current engine state dirty; trigger a debounced PUT.
     *  Called by every mutation path. Cheap when called many times in
     *  a row (e.g. replay tick stream) — only fires one PUT per
     *  quiet 250 ms window. */
    _markDirty() {
      if (!this._layoutId || !this._symbol) return;
      this._dirty = true;
      if (this._saveTimer != null) clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        this._flush();
      }, this._saveDelayMs);
    },

    async _flush() {
      if (!this._dirty) return;
      if (this._saving) {
        // Re-queue: another mutation may have fired during the
        // in-flight PUT. Don't drop it.
        this._markDirty();
        return;
      }
      if (!this._layoutId || !this._symbol || !this.engine) return;
      const snap = this.engine.serialize();
      this._dirty = false;
      this._saving = true;
      try {
        await fetch(
          `/api/sim?layout=${encodeURIComponent(this._layoutId)}&symbol=${encodeURIComponent(this._symbol)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(snap),
          });
      } catch (e) {
        console.warn('[sim] _flush PUT failed', e);
        this._dirty = true;     // try again next mutation
      } finally {
        this._saving = false;
      }
    },

    /** Force-flush right now (no debounce). Used by layout switch to
     *  guarantee the outgoing layout's state hits the server before we
     *  swap context. Cancels any pending timer to avoid a duplicate
     *  PUT a moment later. */
    async flushNow() {
      if (this._saveTimer != null) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }
      if (!this._dirty) return;
      await this._flush();
    },

    /** Resolve the bar that "now" maps to. Replay-aware.
     *
     *  In replay, `displayBars[cursorBarIdx]` may still be a placeholder
     *  (the user just picked the cursor and hasn't yet ticked). In that
     *  case we STILL return the placeholder — its open === close ===
     *  `placeholderFillPrice` (the previous real bar's close), which is
     *  a sensible "fill at this moment" price.
     *
     *  IMPORTANT — placeholders carry STRETCHED high/low purely so
     *  KLineChart's Y-axis autoscale stays stable when the user pans
     *  into placeholder territory (see replay.js _computePlaceholderRange).
     *  Those stretched values are a *rendering* hint, not the actual
     *  price action. Any consumer that compares the bar against real
     *  prices (sim engine matching for TP/SL triggers, bid/ask read,
     *  trade-arrow wick anchor) MUST treat placeholders as a single
     *  instant price. We normalise high/low back to close before
     *  returning so callers don't have to remember this distinction.
     *  Without this, clicking 確認 immediately fired the just-placed
     *  TP/SL because the stretched range trivially contained both. */
    getLatestBar() {
      const R = window.Replay;
      let bar = null;
      if (R && R.active && R.displayBars && R.displayBars.length) {
        const cur = R.displayBars[R.cursorBarIdx];
        if (cur) bar = cur;
      }
      if (!bar) {
        const bars = (window.App && window.App.currentBars) || [];
        for (let i = bars.length - 1; i >= 0; i--) {
          if (bars[i] && !bars[i]._placeholder) { bar = bars[i]; break; }
        }
      }
      if (bar && bar._placeholder) {
        return { ...bar, high: bar.close, low: bar.close };
      }
      return bar;
    },

    /** Tick once against the CURRENT bar (the cursor's in-progress
     *  bar in replay, or the latest loaded bar otherwise). Used after
     *  placeOrder so market orders fill at the price the user could
     *  see at the moment they clicked — replay-frozen-time semantic
     *  per spec § Order types. Without this, replay placements would
     *  queue the market order and only fill on the NEXT replay tick
     *  (= next bar's close), which is the very bug the spec calls out. */
    _tickNow() {
      const bar = this.getLatestBar();
      if (bar) this.engine.processBar(bar);
    },

    /** Place an order on the active branch.
     *
     *  Async because of the branching-replay-spec §3.2.3 hindsight-fork
     *  prompt: when the user's cursor is at a past position they've
     *  already played past, placing an order on `main` first triggers
     *  a fork modal. Returns null if the user cancels the fork.
     *
     *  Callers (close / closeAndReverse / market submit / draft commit)
     *  all fire-and-forget the return value — see audit before this
     *  change. New callers: don't rely on synchronous resolution. */
    async placeOrder(args) {
      if (!this.engine) return null;

      // branching-replay-spec §3.2.3 — if cursor was rewound and we're
      // still on main, force a fork before the order lands. User can
      // cancel; if so, abort the placement entirely.
      const forkOk = await this._maybePromptCursorJumpFork();
      if (!forkOk) return null;

      // branching-replay-spec §7.5: stamp every placement with the
      // branch the user is currently viewing so the resulting trade
      // bucketed correctly in the branch panel + statistics. Defaults
      // to 'main' when BranchEngine isn't loaded (early-boot ordering
      // safety; production always has BranchEngine.init() first).
      // Read AFTER _maybePromptCursorJumpFork because that path may
      // have switched the active branch to a freshly-created one.
      const branchId = (window.BranchEngine && window.BranchEngine.activeBranchId)
        || 'main';
      // Forward the current cursor / latest-bar timestamp as `atBarTs`
      // so the engine can stamp `createdAtBarTs` correctly even on the
      // first-ever order (when state.lastBar is still null because no
      // processBar has run yet — the very-first-limit case in replay).
      // Without this, freshly-placed limits would slip through the
      // same-bar defer rule and fill instantly on _tickNow.
      const nowBar = this.getLatestBar();
      const atBarTs = nowBar ? nowBar.timestamp : null;
      let id;
      try {
        id = this.engine.placeOrder({ ...args, branchId, atBarTs });
      } catch (e) {
        console.warn('[sim] placeOrder failed', e.message);
        Panel.flashError(e.message);
        return null;
      }
      // Fill against the current paused bar regardless of replay state
      // — markets must NOT wait for the next tick. Limits placed on
      // the same bar SKIP this tick (deferred to the next bar) per the
      // _freshlyPlaced check inside processBar's pass 3.
      this._tickNow();
      this._markDirty();
      Panel.refresh();
      Overlays.sync();
      return id;
    },

    /** branching-replay-spec §3.2.3 — gate before every placeOrder.
     *
     *  Trigger: replay active AND cursor < maxCursorTs AND active branch
     *  kind === 'main'. Non-main branches are already exploration
     *  territory; firing the modal there would just nag the user.
     *
     *  Returns:
     *    true  — proceed with placement (no prompt needed, OR user
     *            confirmed fork and we switched to the new branch)
     *    false — user cancelled the fork; caller must abort placement.
     *
     *  Side effect on confirm: creates a new branch via
     *  BranchEngine.createBranch and switches active to it. The
     *  subsequent engine.placeOrder reads BranchEngine.activeBranchId
     *  and tags the order to the new branch automatically. */
    async _maybePromptCursorJumpFork() {
      const Replay = window.Replay;
      const Br = window.BranchEngine;
      const Mod = window.BranchModals;
      if (!Replay || !Replay.active) return true;
      if (!Number.isFinite(Replay.cursorTimestamp)) return true;
      if (!Number.isFinite(Replay.maxCursorTs)) return true;
      if (Replay.cursorTimestamp >= Replay.maxCursorTs) return true;
      if (!Br || !Br.activeBranchId) return true;
      const activeBr = Br.getBranch && Br.getBranch(Br.activeBranchId);
      if (!activeBr || activeBr.kind !== 'main') return true;
      // Modal infrastructure missing — fail open (place the order,
      // matching forkOrDiscard's fallback behavior).
      if (!Mod || !Mod.cursorJumpFork) return true;

      const cursorTs = Replay.cursorTimestamp;
      const cursorIdx = Replay.cursorBarIdx;
      const maxTs = Replay.maxCursorTs;
      const maxLabel = (typeof window.formatBarTime === 'function')
        ? window.formatBarTime(maxTs) : '';
      // Default name: branch-N where N is current branch count + 1
      // (matches manualFork's pattern from sim_overlays).
      const branchCount = (Br.getBranches && Br.getBranches().length) || 1;
      const defaultName = `branch-${branchCount}`;

      const result = await Mod.cursorJumpFork({
        parentName: activeBr.name,
        forkBarLabel: (window.I18n && window.I18n.t)
          ? window.I18n.t('branch.barLabel', { n: cursorIdx + 1 })
          : `第 ${cursorIdx + 1} 根`,
        forkBarTimestamp: cursorTs,
        maxCursorLabel: maxLabel,
        defaultName,
      });
      if (!result || !result.confirmed) return false;

      // Fork: create branch and switch. Order goes onto the new branch
      // because branchId is read fresh after this method returns.
      if (Br.createBranch && Br.setActiveBranch) {
        const branch = Br.createBranch({
          name: result.name,
          kind: result.kind,
          parentId: Br.activeBranchId,
          forkBar: cursorIdx,
          forkBarTimestamp: cursorTs,
          note: result.note,
        });
        if (branch && branch.id) Br.setActiveBranch(branch.id);
      }
      return true;
    },

    cancelOrder(id) {
      if (!this.engine) return false;
      const ok = this.engine.cancelOrder(id);
      if (ok) this._markDirty();
      Panel.refresh();
      Overlays.sync();
      return ok;
    },

    /** Manual market close of the open position (whole qty). */
    closePosition() {
      if (!this.engine) return;
      const pos = this.engine.getPositions()[0];
      if (!pos) return;
      const oppSide = pos.side === 'long' ? 'sell' : 'buy';
      this.placeOrder({ side: oppSide, type: 'market', qty: pos.qty });
    },

    /** 平倉反手 — close the current position AND open the reverse with
     *  the same qty in a single market order. The engine's existing
     *  flip logic in `_applyOrderToPosition` does the work: a 2×qty
     *  opposite-side market crosses zero and naturally produces both
     *  events (old position closed + new flipped position opened) at
     *  the same fill price.
     *
     *  `isReverse: true` flag stamps the order so `_deriveCloseReason`
     *  marks the closing leg as `'reverse'` instead of `'manual'`. */
    closeAndReverse() {
      if (!this.engine) return;
      const pos = this.engine.getPositions()[0];
      if (!pos) return;
      const oppSide = pos.side === 'long' ? 'sell' : 'buy';
      this.placeOrder({
        side: oppSide,
        type: 'market',
        qty: pos.qty * 2,
        isReverse: true,
      });
    },

    /** Called by replay.js after each tick. Step-7 will wire this in
     *  replay.js itself; for step 2 it's exposed but not yet called. */
    onReplayTick() {
      const bar = this.getLatestBar();
      // Only mark dirty when a fill happened — pure MAE/MFE bumps are
      // ephemeral (re-derived from closedHistory + bars on reload), no
      // need to PUT every tick or replay would hammer the server.
      let fills = null;
      if (bar) fills = this.engine.processBar(bar);
      if (Array.isArray(fills) && fills.length) this._markDirty();
      Panel.refresh();
      Overlays.sync();
    },

    /** Delete one trade (open or closed) by positionId. Wipes the
     *  position + its entry / bracket-child orders and reverses the
     *  balance impact. UI hooks: 交易清單 row ✕ button. */
    deleteTrade(positionId) {
      if (!this.engine || !this.engine.deleteTrade) return false;
      const ok = this.engine.deleteTrade(positionId);
      if (ok) {
        this._markDirty();
        Panel.refresh();
        Overlays.sync();
        if (window.SimHistory && window.SimHistory.refresh) {
          window.SimHistory.refresh();
        }
      }
      return ok;
    },

    /** Clear ALL trades / orders on the given branch. Used by the
     *  「清除本分支」 button in 交易清單 (after普通確認 modal).
     *  Branch-aware: this only touches branchId-matching records,
     *  leaving sibling-branch trades intact. */
    clearBranch(branchId) {
      if (!this.engine || !this.engine.clearBranch) return false;
      if (!branchId) return false;
      const ok = this.engine.clearBranch(branchId);
      if (ok) {
        this._markDirty();
        Panel.refresh();
        Overlays.sync();
        if (window.SimHistory && window.SimHistory.refresh) {
          window.SimHistory.refresh();
        }
      }
      return ok;
    },

    /** Convenience: clear the currently-active branch's trades.
     *  Reads BranchEngine.activeBranchId; defaults to 'main'. */
    clearActiveBranch() {
      const branchId = (window.BranchEngine && window.BranchEngine.activeBranchId)
        || 'main';
      return this.clearBranch(branchId);
    },

    /** Reload spec + recreate engine when the chart's symbol changes.
     *  Flushes any pending save against the OLD symbol first, then
     *  loads (or creates) the engine state for the new symbol. */
    async onSymbolChanged(newSymbol) {
      await this.loadForLayout(this._layoutId, newSymbol || 'NQ');
    },
  };

  // ------------------------------------------------------------------
  // Panel — DOM-level UI module.
  // ------------------------------------------------------------------
  const Panel = {
    el: null,
    isOpen: false,
    currentType: 'market',

    // Proposal phase state — see tp-sl-drop-spec.
    // Becomes `active: true` the moment an entry fills and stays true
    // until the position closes. Per-leg presence is encoded by
    // `tp != null` / `sl != null` (no separate enable flags); the user
    // drags +TP / +SL drop sources from the entry-actions group onto
    // the chart to populate a leg. `draggingLeg` tracks which leg the
    // user is currently dragging — when non-null, the corresponding
    // band is rendered with a fill tint instead of just a thin line.
    proposalState: {
      active: false,
      positionId: null,
      tp: null,
      sl: null,
      draggingLeg: null,    // 'tp' | 'sl' | null
      // bracket-ux-polish §1: phase + locked-on-confirm prices.
      phase: 'pending',     // 'pending' | 'armed' | 'editing'
      lockedTp: null,
      lockedSl: null,
      // bracket-ux-polish §4: per-leg validity + can-confirm gate.
      // Recomputed by Panel.refreshValidity() on every relevant
      // event (drag, panel input, replay tick, position open).
      validity: { tp: 'disabled', sl: 'disabled', canConfirm: false },
    },
    _dispositioned: new Set(),   // legacy guard — kept defensively; no
                                 // longer added to (the discard path
                                 // resets legs without dispositioning)

    init() {
      this.el = document.getElementById('sim-panel');
      if (!this.el) return;

      // Spec i18n §4.3: refresh on language change. Idempotent guard
      // prevents stacked listeners across hot-reloads / accidental
      // double-init (test scenarios). refresh() rebuilds CTA / position
      // header / pending list. _syncPendingTickets() rebuilds the
      // chart-side draft / committed-limit tickets, which keep their
      // own DOM separate from refresh().
      if (!Panel._i18nWired) {
        Panel._i18nWired = true;
        document.addEventListener('i18n:change', () => {
          try { this.refresh(); } catch (e) {}
          try { this._syncPendingTickets(); } catch (e) {}
        });
      }

      // Topbar toggle
      const btn = document.getElementById('btn-sim');
      if (btn) btn.addEventListener('click', () => this.toggle());

      // Close button
      const close = document.getElementById('sim-panel-close');
      if (close) close.addEventListener('click', () => this.close());

      // Order type tabs
      this.el.querySelectorAll('.sim-type-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          if (tab.classList.contains('disabled')) return;
          this.setType(tab.dataset.simType);
        });
      });

      // Inputs that affect the bid/ask + CTA labels
      ['sim-qty', 'sim-price', 'sim-stop'].forEach(id => {
        const inp = document.getElementById(id);
        if (inp) inp.addEventListener('input', () => this.refresh());
      });

      // CTAs
      document.getElementById('sim-cta-buy').addEventListener('click', () => this.submit('buy'));
      document.getElementById('sim-cta-sell').addEventListener('click', () => this.submit('sell'));

      // Position view: 平倉
      const closeBtn = document.getElementById('sim-pos-close');
      if (closeBtn) closeBtn.addEventListener('click', () => Controller.closePosition());

      // The side-panel TP/SL inputs / toggles / 確認 / 捨棄 row was
      // removed in tp-sl-drop-spec §6 — TP/SL setup is fully chart-side
      // now (drag +TP / +SL drop sources from the entry-actions group).
      // The chart-side 確認 / 捨棄 buttons inside the entry ticket are
      // wired below (`inlineConf` / `inlineDisc`).

      // bracket-ux-polish §2: DOM tickets (TP / Entry / SL) live in
      // #sim-bracket-tickets. The inline action group ([↕][捨棄][確認])
      // is now nested INSIDE the entry ticket so they layout as one
      // horizontal flex row at entry-Y. Cache refs so the per-tick
      // sync loop can update without DOM lookups.
      this._ticketsEl = document.getElementById('sim-bracket-tickets');
      this._ticketTp     = this._ticketsEl && this._ticketsEl.querySelector('.sim-ticket.tp');
      this._ticketEntry  = this._ticketsEl && this._ticketsEl.querySelector('.sim-ticket.entry');
      this._ticketSl     = this._ticketsEl && this._ticketsEl.querySelector('.sim-ticket.sl');
      this._actionsEl    = document.getElementById('sim-bracket-actions');

      const inlineConf = this._actionsEl && this._actionsEl.querySelector('.sim-inline-confirm');
      const inlineDisc = this._actionsEl && this._actionsEl.querySelector('.sim-inline-discard');
      const inlineFlip = this._actionsEl && this._actionsEl.querySelector('.sim-inline-flip');
      if (inlineConf) inlineConf.addEventListener('click', () => this._confirmProposal());
      if (inlineDisc) inlineDisc.addEventListener('click', () => this._discardProposal());
      if (inlineFlip) inlineFlip.addEventListener('click', () => Controller.closeAndReverse());

      // ✕ glyph on TP/SL tickets cancels that leg (toggles its
      // -enabled flag off, drops the chart band). On the entry ticket
      // the ✕ closes the position via market exit (TradingView parity).
      const wireSegX = (ticket, handler) => {
        if (!ticket) return;
        const x = ticket.querySelector('.seg-x');
        if (x) x.addEventListener('click', (e) => {
          // ✕ should never start a vertical drag — stop the mousedown
          // from also triggering _wireTicketDrag below.
          e.stopPropagation();
          handler();
        });
      };
      wireSegX(this._ticketTp,    () => this._cancelLegFromTicket('tp'));
      wireSegX(this._ticketSl,    () => this._cancelLegFromTicket('sl'));
      wireSegX(this._ticketEntry, () => Controller.closePosition());

      // bracket-ux-polish §2: vertical drag on TP/SL tickets. The ticket
      // body IS the drag affordance — no separate canvas circle. Mouse Y
      // is converted via chart.convertFromPixel into a price; ps.tp / ps.sl
      // updates each frame so the line, band fill, ticket position, and
      // rail dot all move in lockstep. Entry ticket is NOT draggable —
      // entry price is fixed once the order fills.
      this._wireTicketDrag(this._ticketTp, 'tp');
      this._wireTicketDrag(this._ticketSl, 'sl');

      // bracket-ux-polish §3: vertical rail + 3 dots. Cached refs so
      // the per-tick sync can update each dot's `top` without lookups.
      this._railEl       = document.getElementById('sim-bracket-rail');
      this._railDotTp    = this._railEl && this._railEl.querySelector('.sim-rail-dot.tp');
      this._railDotEntry = this._railEl && this._railEl.querySelector('.sim-rail-dot.entry');
      this._railDotSl    = this._railEl && this._railEl.querySelector('.sim-rail-dot.sl');

      // tp-sl-drop-spec §2/§3: wire the +TP / +SL drop sources inside
      // the entry-actions group + cache the shared ghost mini-ticket
      // element. Ghost is `position: fixed` with pointer-events: none
      // so the chart still reports hovered prices underneath while the
      // user is dragging a leg.
      this._legGhostEl = document.getElementById('sim-leg-ghost');
      const dropBtns = this._actionsEl
        ? this._actionsEl.querySelectorAll('.sim-leg-drop')
        : [];
      dropBtns.forEach((btn) => {
        btn.addEventListener('mousedown', (e) => {
          const leg = btn.dataset.leg;
          if (leg === 'tp' || leg === 'sl') this._beginLegDrop(leg, e);
        });
      });

      // DOM container for pending-order tickets (limit / stop / stop-limit).
      // Populated dynamically by `_syncPendingTickets` whenever the
      // engine's pending-order list changes.
      this._pendingTicketsEl = document.getElementById('sim-pending-tickets');

      // bracket-ux-polish §3 hover counter: rail line + dots fade in only
      // when the cursor hovers any ticket (or while a drag is in flight).
      // Counter avoids flicker as the cursor crosses between adjacent
      // tickets — increment on enter, decrement on leave; the brief
      // counter == 0 frame between siblings is masked by the 200ms CSS
      // transition. Inline action buttons are nested inside the entry
      // ticket so they're naturally covered by the entry-ticket hover.
      this._hoveredCount = 0;
      const incHover = () => {
        this._hoveredCount++;
        this._updateRailVisibility();
      };
      const decHover = () => {
        this._hoveredCount = Math.max(0, this._hoveredCount - 1);
        this._updateRailVisibility();
      };
      [this._ticketTp, this._ticketEntry, this._ticketSl].forEach((t) => {
        if (!t) return;
        t.addEventListener('mouseenter', incHover);
        t.addEventListener('mouseleave', decHover);
      });

      // Document-level mouseup ends any chart-side drag (set by the
      // overlay's performEventPressedMove). KLineChart 9.8.x doesn't
      // expose a clean drag-end callback for custom overlays, so we
      // just listen to the global mouseup as a poor-man's release
      // detector — clears dragging only if NOT focused on a panel
      // input (otherwise we'd clobber the panel-edit dragging state).
      document.addEventListener('mouseup', () => {
        const tag = (document.activeElement && document.activeElement.tagName) || '';
        const focused = (tag === 'INPUT' || tag === 'TEXTAREA');
        if (!focused && this.proposalState.draggingLeg) {
          this._setDragging(null);
        }
      }, true);

      // Esc to close panel; B / S hotkeys for buy/sell market focus
      document.addEventListener('keydown', (e) => {
        if (!this.isOpen) return;
        // Don't hijack keys while typing in form inputs
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          if (e.key === 'Escape') { e.target.blur(); }
          return;
        }
        if (e.key === 'Escape') { this.close(); e.preventDefault(); }
      });

      // Continuous ticket re-positioning so DOM tickets / rail dots /
      // pending-order tickets stay locked to their price line while the
      // user zooms / pans. Without this, tickets only update on
      // Panel.refresh() (which doesn't fire on raw chart pan), so a
      // zoom out leaves tickets stuck at their old pixel Y while the
      // canvas line moves with the new viewport. Extremely cheap —
      // each frame: 1–4 convertToPixel calls + a few `top:` writes.
      // Self-throttling: skips the work entirely when there's nothing
      // to position (no open position + no active pending orders).
      this._startTicketSyncLoop();
    },

    _startTicketSyncLoop() {
      if (this._ticketRafHandle != null) return;
      const tick = () => {
        try { this._syncTicketPositions(); } catch (e) { /* ignore */ }
        this._ticketRafHandle = requestAnimationFrame(tick);
      };
      this._ticketRafHandle = requestAnimationFrame(tick);
    },

    /** Lightweight position-only sync — does NOT rebuild content,
     *  visibility, or text. Re-positions every visible ticket / rail
     *  dot via a SINGLE batched `chart.convertToPixel` call, then
     *  applies all `top` writes in a separate pass. Two passes (read
     *  + write) avoid layout thrashing during chart drag/zoom, where
     *  this function competes with KLineChart's own rAF redraw.
     *
     *  Bails out fast (no convertToPixel call at all) when nothing
     *  visible needs positioning — keeps the rAF loop almost free
     *  during idle browsing. */
    _syncTicketPositions() {
      const chart = (window.App && window.App.chart) || null;
      if (!chart || !chart.convertToPixel) return;
      const eng = Controller.engine;
      if (!eng) return;
      const ps = this.proposalState;
      const pos = eng.getPositions()[0];

      // ---- Pass A: collect (element → price) queries ----
      // One push per element that needs its `top` updated this frame.
      const queries = [];
      const push = (el, price) => {
        if (!el || !Number.isFinite(price)) return;
        if (el.hidden) return;
        queries.push({ el, price });
      };

      // Bracket entry / TP / SL tickets
      if (pos && this._ticketEntry) push(this._ticketEntry, pos.avgEntryPrice);
      if (this._ticketTp) {
        let tpPrice = null;
        if (ps.active && Number.isFinite(ps.tp)) tpPrice = ps.tp;
        else if (pos && pos.entryOrderIds && pos.entryOrderIds.length) {
          const tpChild = eng.getPendingOrders().find(
            o => o.bracketParentId === pos.entryOrderIds[0] && o.type === 'limit');
          if (tpChild) tpPrice = tpChild.price;
        }
        push(this._ticketTp, tpPrice);
      }
      if (this._ticketSl) {
        let slPrice = null;
        if (ps.active && Number.isFinite(ps.sl)) slPrice = ps.sl;
        else if (pos && pos.entryOrderIds && pos.entryOrderIds.length) {
          const slChild = eng.getPendingOrders().find(
            o => o.bracketParentId === pos.entryOrderIds[0] && o.type === 'stop');
          if (slChild) slPrice = slChild.stopPrice;
        }
        push(this._ticketSl, slPrice);
      }
      // Rail dots
      if (this._railEl && !this._railEl.hidden) {
        if (pos) push(this._railDotEntry, pos.avgEntryPrice);
        if (ps.active && Number.isFinite(ps.tp)) push(this._railDotTp, ps.tp);
        if (ps.active && Number.isFinite(ps.sl)) push(this._railDotSl, ps.sl);
      }
      // Pending-order DOM tickets — engine + draft + editing-staged
      if (this._pendingTicketsEl && !this._pendingTicketsEl.hidden) {
        const tickets = this._pendingTicketsEl.querySelectorAll('.sim-pending-ticket');
        for (const t of tickets) {
          let price = null;
          const state = t.dataset.state;
          if (state === 'draft') {
            const draft = this._draftPending;
            if (!draft || draft._ticketEl !== t) continue;
            price = (draft.type === 'stop') ? draft.stopPrice : draft.price;
          } else if (state === 'editing'
                     && Number.isFinite(parseFloat(t.dataset.stagedPrice))) {
            price = parseFloat(t.dataset.stagedPrice);
          } else {
            const orderId = parseInt(t.dataset.orderId, 10);
            if (!Number.isFinite(orderId)) continue;
            const order = eng.getOrder(orderId);
            if (!order || order.status !== 'pending' || !order.active) continue;
            price = (order.type === 'stop' || order.type === 'stop_limit')
              ? order.stopPrice : order.price;
          }
          push(t, price);
        }
      }

      // No visible elements → idle path: zero convertToPixel work.
      if (!queries.length) return;

      // ---- Pass B: single batched convertToPixel call ----
      // KLineChart 9.x accepts an array; one call is much cheaper than
      // N individual calls (each does its own bar-lookup + math).
      const tsRef = Date.now();   // value field carries the price; ts
                                  // is unused for Y conversion but kept
                                  // identical so kchart's API is happy
      let pixels;
      try {
        pixels = chart.convertToPixel(
          queries.map(q => ({ timestamp: tsRef, value: q.price })),
          { paneId: 'candle_pane' }
        );
      } catch (e) { return; }
      if (!Array.isArray(pixels)) return;

      // ---- Pass C: write all `top` values in one tight loop ----
      // Browsers can batch contiguous style writes (no read in between
      // → no forced layout flush per write).
      for (let i = 0; i < queries.length; i++) {
        const y = pixels[i] && pixels[i].y;
        if (Number.isFinite(y)) queries[i].el.style.top = y + 'px';
      }
    },

    toggle() { this.isOpen ? this.close() : this.open(); },
    open() {
      if (!this.el) return;
      this.el.classList.remove('hidden');
      this.isOpen = true;
      const tbtn = document.getElementById('btn-sim');
      if (tbtn) tbtn.classList.add('active');
      this._resizeChart();   // chart-area shrunk; tell KLineChart to redraw
      this.refresh();
    },
    close() {
      if (!this.el) return;
      this.el.classList.add('hidden');
      this.isOpen = false;
      const tbtn = document.getElementById('btn-sim');
      if (tbtn) tbtn.classList.remove('active');
      this._resizeChart();   // chart-area expanded back
    },
    /** KLineChart caches its container size at init time and only
     *  redraws into the larger / smaller box when explicitly told.
     *  Without this call the chart stays at its old width and the
     *  newly-revealed (or hidden) flex space shows as empty. */
    _resizeChart() {
      const chart = (window.App && window.App.chart) || null;
      if (chart && chart.resize) {
        // Defer one frame so the layout has actually reflowed before
        // we ask the chart to measure itself.
        requestAnimationFrame(() => { try { chart.resize(); } catch (e) { /* ignore */ } });
      }
    },

    setType(type) {
      this.currentType = type;
      this.el.querySelectorAll('.sim-type-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.simType === type);
      });
      // Show/hide price + stop fields based on type.
      const priceRow = this.el.querySelector('[data-sim-field="price"]');
      const stopRow  = this.el.querySelector('[data-sim-field="stop"]');
      const priceLabel = document.getElementById('sim-price-label');
      const needsPrice = (type === 'limit' || type === 'stop_limit');
      const needsStop  = (type === 'stop'  || type === 'stop_limit');
      priceRow.classList.toggle('hidden', !needsPrice);
      stopRow.classList.toggle('hidden', !needsStop);
      if (priceLabel) priceLabel.textContent = (window.I18n && window.I18n.t)
        ? window.I18n.t('sim.fieldLimitPrice') : '限價';
      // Pre-fill price/stop with the latest bar's close so the user
      // doesn't see an empty box.
      const bar = Controller.getLatestBar();
      if (bar && needsPrice) {
        const priceInp = document.getElementById('sim-price');
        if (!priceInp.value) priceInp.value = bar.close.toFixed(2);
      }
      if (bar && needsStop) {
        const stopInp = document.getElementById('sim-stop');
        if (!stopInp.value) stopInp.value = bar.close.toFixed(2);
      }
      this.refresh();
    },

    submit(side) {
      const qty   = parseFloat(document.getElementById('sim-qty').value);
      const price = parseFloat(document.getElementById('sim-price').value);
      const stop  = parseFloat(document.getElementById('sim-stop').value);
      const t = this.currentType;
      if (!(qty > 0)) {
        this.flashError((window.I18n && window.I18n.t)
          ? window.I18n.t('sim.errQtyZero') : '單位必須大於 0');
        return;
      }

      // Market orders fill immediately — go straight to the engine.
      if (t === 'market') {
        Controller.placeOrder({ side, type: t, qty });
        return;
      }

      // Limit / stop / stop-limit: enter DRAFT mode instead of placing
      // the order directly. The chart shows a dimmed pending line +
      // ticket with a bright 買入/賣出 button. The engine sees nothing
      // until the user clicks that chart-side button to commit. Drag-
      // adjust during draft updates the local price; ✕ cancels.
      const t_ = (window.I18n && window.I18n.t) || ((k) => k);
      if (t === 'limit' || t === 'stop_limit') {
        if (!Number.isFinite(price)) { this.flashError(t_('sim.errLimitRequired')); return; }
      }
      if (t === 'stop' || t === 'stop_limit') {
        if (!Number.isFinite(stop))  { this.flashError(t_('sim.errTriggerRequired')); return; }
      }
      this._createDraftPending({ side, type: t, qty, price, stopPrice: stop });
    },

    /** Re-render every dynamic part of the panel from current engine state. */
    refresh() {
      if (!this.el || !this.isOpen) return;
      const eng = Controller.engine;
      if (!eng) return;

      // Symbol label
      const sym = (window.App && window.App.currentSymbol) || 'NQ';
      const symEl = document.getElementById('sim-panel-symbol');
      if (symEl) symEl.textContent = sym + '!';

      // Switch between entry / position view based on whether a position is open.
      const pos = eng.getPositions()[0];
      const entryView    = this.el.querySelector('[data-sim-view="entry"]');
      const positionView = this.el.querySelector('[data-sim-view="position"]');
      if (pos) {
        entryView.classList.add('hidden');
        positionView.classList.remove('hidden');
        this._renderPositionView(pos);
      } else {
        entryView.classList.remove('hidden');
        positionView.classList.add('hidden');
        this._renderEntryView(sym);
        // No open position → hide all chart-side bracket UI.
        this._syncBracketTickets(null, false);
      }
      this._renderPendingList();
      this._renderReplayWarning();
    },

    _renderEntryView(symbol) {
      const bar = Controller.getLatestBar();
      const spec = Controller.spec || {};
      const halfSpread = (spec.spread || 0) / 2;
      const close = bar ? bar.close : null;
      const bid = (close != null) ? close - halfSpread : null;
      const ask = (close != null) ? close + halfSpread : null;

      // Bid / Ask
      document.getElementById('sim-bid').textContent =
        (bid != null) ? bid.toFixed(2) : '—';
      document.getElementById('sim-ask').textContent =
        (ask != null) ? ask.toFixed(2) : '—';

      // Tick value: pointValue × tickSize × lotSize × 1 contract
      const tickValue = (spec.pointValue || 0) * (spec.tickSize || 0) * (spec.lotSize || 1);
      document.getElementById('sim-info-tick').textContent =
        (tickValue > 0) ? '$' + tickValue.toFixed(2) : '—';

      // Notional: qty × price × pointValue × lotSize
      const qty = parseFloat(document.getElementById('sim-qty').value) || 0;
      const refPrice = (this.currentType === 'limit' || this.currentType === 'stop_limit')
        ? (parseFloat(document.getElementById('sim-price').value) || close)
        : (this.currentType === 'stop')
          ? (parseFloat(document.getElementById('sim-stop').value) || close)
          : close;
      const notional = (qty > 0 && refPrice != null)
        ? qty * refPrice * (spec.pointValue || 1) * (spec.lotSize || 1)
        : null;
      document.getElementById('sim-info-notional').textContent =
        (notional != null) ? '$' + Math.round(notional).toLocaleString() : '—';

      // CTA labels — spec i18n §3.4 sim.ctaBuy / sim.ctaSell with
      // {qty}/{symbol}/{type} interpolation. CTA uses full type names
      // (Market, Limit, Stop, Stop-Limit) per spec §6.2 case 6. The
      // short "Mkt" form (sim.typeMarketShort) is reserved for the
      // compact pending-list meta line.
      const t_ = (window.I18n && window.I18n.t) || ((k) => k);
      const _typeKeys = {
        market:     'sim.typeMarket',
        limit:      'sim.typeLimit',
        stop:       'sim.typeStop',
        stop_limit: 'sim.typeStopLimit',
      };
      const typeLabel = t_(_typeKeys[this.currentType] || 'sim.typeMarket');
      const qtyLabel = (qty > 0) ? qty : '?';
      document.getElementById('sim-cta-buy').textContent  =
        t_('sim.ctaBuy',  { qty: qtyLabel, symbol, type: typeLabel });
      document.getElementById('sim-cta-sell').textContent =
        t_('sim.ctaSell', { qty: qtyLabel, symbol, type: typeLabel });
      const valid = (qty > 0)
        && (this.currentType !== 'limit' || Number.isFinite(parseFloat(document.getElementById('sim-price').value)))
        && (this.currentType !== 'stop'  || Number.isFinite(parseFloat(document.getElementById('sim-stop').value)))
        && (this.currentType !== 'stop_limit'
            || (Number.isFinite(parseFloat(document.getElementById('sim-price').value))
              && Number.isFinite(parseFloat(document.getElementById('sim-stop').value))));
      document.getElementById('sim-cta-buy').disabled  = !valid;
      document.getElementById('sim-cta-sell').disabled = !valid;
    },

    _renderPositionView(pos) {
      const t_ = (window.I18n && window.I18n.t) || ((k) => k);
      const sideText = pos.side === 'long' ? t_('sim.posSideLong') : t_('sim.posSideShort');
      document.getElementById('sim-pos-header').textContent = t_('sim.posHeader', {
        side: sideText,
        qty: pos.qty,
        entry: pos.avgEntryPrice.toFixed(2),
      });
      const fmt = window.PositionCalc && window.PositionCalc.formatUSD
        ? window.PositionCalc.formatUSD
        : (n) => '$' + n.toFixed(2);
      document.getElementById('sim-pos-pnl').textContent  = fmt(pos.unrealisedPnL, 2);
      document.getElementById('sim-pos-mfe').textContent  = fmt(pos.mfe, 2);
      document.getElementById('sim-pos-mae').textContent  = fmt(pos.mae, 2);
      const ts = pos.openedAtBarTs;
      const opened = ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '—';
      document.getElementById('sim-pos-opened').textContent = opened;

      // Maybe transition into proposal phase. We do this here (in
      // refresh, not at fill time) because the panel may not have
      // been open at the moment of fill — the user might have placed
      // an order then opened the panel afterwards. Either way, by the
      // time refresh runs we know exactly whether to propose.
      this._maybeStartProposal(pos);
      // bracket-ux-polish §4: validity gate runs every refresh so
      // replay-tick advances re-evaluate price-vs-bar even if the
      // user hasn't moved anything (a previously-valid TP can become
      // invalid when a new bar with a higher high appears).
      this.refreshValidity();

      const ps = this.proposalState;
      const inProposal = ps.active && ps.positionId === pos.id;
      const hasAnyLeg  = inProposal
        && (Number.isFinite(ps.tp) || Number.isFinite(ps.sl));
      const committedActions = document.getElementById('sim-pos-committed-actions');

      // tp-sl-drop-spec §7: 確認/捨棄 visible only when there's
      // something to confirm (at least one leg has a price). The whole
      // entry-actions GROUP visibility (which hosts the +TP/+SL drop
      // sources) gets a more permissive rule — see _syncBracketTickets.
      const showConfirmButtons = inProposal && (
        (ps.phase === 'pending' && hasAnyLeg) ||
        ps.phase === 'editing'
      );

      // 市價平倉 stays available throughout — the user can always close
      // the position manually regardless of bracket proposal state.
      if (committedActions) committedActions.classList.remove('hidden');
      // Drives both DOM tickets (TP / Entry / SL) AND the vertical rail.
      // Per-button visibility for the chart-side action group lives
      // inside _syncBracketTickets: drop sources hide once their leg
      // is populated; 確認/捨棄 hide when there's nothing to confirm.
      this._syncBracketTickets(pos, showConfirmButtons);
    },

    /** Drive the DOM bracket tickets (TP / Entry / SL) + the vertical
     *  rail (spec §2 + §3). Called from `_renderPositionView` on every
     *  refresh.
     *
     *  Tickets:
     *  - Each ticket's `top` is set from `convertToPixel(price)` so it
     *    rides the price line as the chart pans / zooms (subject to the
     *    same caveat as the inline buttons — only updates on `refresh()`
     *    triggers, not on raw chart-pan).
     *  - TP / SL: visible when their leg is enabled AND a position is
     *    open (proposal or committed). Hidden if the leg is null/off.
     *  - Entry: visible whenever a position is open.
     *  - Inline action group inside the entry ticket: visible only
     *    during phase 'pending'+hasLeg or 'editing'. Hidden in armed.
     *  - Invalid legs (per `ps.validity.tp/sl`) get `.invalid` class
     *    (CSS box-shadow ring) and the warning ⚠ glyph un-hidden.
     *  - Each ticket's USD label + qty + chevron `«` are updated from
     *    the current proposalState / engine values.
     *
     *  Rail: line + 3 dots, visible when proposal is in pending /
     *  editing AND at least one leg is enabled. Dragging a leg gives
     *  its dot a `.dragging` class (filled blue per spec §3).
     *
     *  `pos` may be null (no open position) — we hide everything.
     *  `actionsVisible` controls just the inline action group (passed
     *  by the caller computed from phase + hasAnyLeg). */
    _syncBracketTickets(pos, actionsVisible) {
      const ticketsEl = this._ticketsEl;
      if (!ticketsEl) return;
      if (!pos) {
        ticketsEl.hidden = true;
        if (this._railEl) this._railEl.hidden = true;
        return;
      }
      ticketsEl.hidden = false;

      const chart = (window.App && window.App.chart) || null;
      const yOf = (price) => {
        if (!chart || !chart.convertToPixel || !Number.isFinite(price)) return null;
        try {
          const px = chart.convertToPixel(
            [{ timestamp: Date.now(), value: price }],
            { paneId: 'candle_pane' }
          );
          const y = Array.isArray(px) ? (px[0] && px[0].y) : (px && px.y);
          return Number.isFinite(y) ? y : null;
        } catch (e) { return null; }
      };

      const ps = this.proposalState;
      const inProposal = !!(ps.active && ps.positionId === pos.id);
      const spec = Controller.spec || {};
      const pv  = spec.pointValue || 1;
      const lot = spec.lotSize    || 1;
      const dir = pos.side === 'long' ? 1 : -1;
      // P&L formatter: + or - prefix, 2 decimals, currency suffix
      // (USD by default, NTD for TXF, etc — spec §2 was USD-only;
      // we now read spec.currency so TWD-quoted contracts display
      // correctly).
      const cur = spec.currency || 'USD';
      const fmtUSD = (n) => {
        const abs = Math.abs(n).toFixed(2);
        const sign = n >= 0 ? '+ ' : '- ';
        return `${sign}${abs} ${cur}`;
      };

      // Resolve current TP/SL price (from proposal during active proposal,
      // else from engine bracket children for the committed/armed case).
      const eng = Controller.engine;
      let tpPrice = null, slPrice = null;
      if (inProposal) {
        if (Number.isFinite(ps.tp)) tpPrice = ps.tp;
        if (Number.isFinite(ps.sl)) slPrice = ps.sl;
      } else if (pos.entryOrderIds && pos.entryOrderIds.length) {
        const parentId = pos.entryOrderIds[0];
        const tpChild = eng.getPendingOrders().find(
          o => o.bracketParentId === parentId && o.type === 'limit');
        const slChild = eng.getPendingOrders().find(
          o => o.bracketParentId === parentId && o.type === 'stop');
        if (tpChild) tpPrice = tpChild.price;
        if (slChild) slPrice = slChild.stopPrice;
      }

      const validity = (inProposal && ps.validity) || {};

      const fillTicket = (ticketEl, price, leg) => {
        if (!ticketEl) return;
        if (!Number.isFinite(price)) {
          ticketEl.hidden = true;
          ticketEl.classList.remove('invalid');
          return;
        }
        const y = yOf(price);
        if (y == null) { ticketEl.hidden = true; return; }
        ticketEl.hidden = false;
        ticketEl.style.top = y + 'px';
        // qty + USD label
        const usd = (price - pos.avgEntryPrice) * dir * pos.qty * pv * lot;
        const qtyEl = ticketEl.querySelector('.qty');
        const plEl  = ticketEl.querySelector('.pl');
        if (qtyEl) qtyEl.textContent = String(pos.qty);
        if (plEl)  plEl.textContent  = fmtUSD(usd);
        // Validity → invalid ring + warning glyph
        const isInvalid = validity[leg] === 'invalid';
        ticketEl.classList.toggle('invalid', isInvalid);
        const warn = ticketEl.querySelector('.sim-ticket-warn');
        if (warn) warn.hidden = !isInvalid;
      };

      fillTicket(this._ticketTp, tpPrice, 'tp');
      fillTicket(this._ticketSl, slPrice, 'sl');

      // ----- Entry ticket (always visible while a position is open) -----
      const entryEl = this._ticketEntry;
      if (entryEl) {
        const y = yOf(pos.avgEntryPrice);
        if (y == null) {
          entryEl.hidden = true;
        } else {
          entryEl.hidden = false;
          entryEl.style.top = y + 'px';
          // Side modifier: short positions get red theming (border,
          // body, action buttons) instead of the default blue. Matches
          // the entry-line overlay color in sim_overlays.js.
          entryEl.classList.toggle('short', pos.side === 'short');
          const qtyEl = entryEl.querySelector('.qty');
          const plEl  = entryEl.querySelector('.pl');
          if (qtyEl) qtyEl.textContent = String(pos.qty);
          // Entry P/L = unrealisedPnL (live ticking value)
          if (plEl) plEl.textContent = fmtUSD(pos.unrealisedPnL || 0);

          // tp-sl-drop-spec §6: R/R segment between qty and USD P/L.
          // Show only when BOTH legs are dropped — otherwise the ratio
          // is undefined. Compute |TP-E| / |E-SL| (price-distance
          // ratio); qty / pv / lot cancel out so we can use the prices
          // directly. The validity warning ⚠ on each leg ticket flags
          // wrong-side drops separately.
          const rrSeg = entryEl.querySelector('.seg-rr');
          const rrEl  = entryEl.querySelector('.rr');
          if (rrSeg) {
            const bothDropped = Number.isFinite(tpPrice)
                              && Number.isFinite(slPrice);
            if (bothDropped) {
              const reward = Math.abs(tpPrice - pos.avgEntryPrice);
              const risk   = Math.abs(pos.avgEntryPrice - slPrice);
              const rr = risk > 0 ? reward / risk : 0;
              if (rrEl) rrEl.textContent = rr > 0
                ? `R/R ${rr.toFixed(2)}`
                : 'R/R —';
              rrSeg.hidden = false;
            } else {
              rrSeg.hidden = true;
            }
          }
        }

        // tp-sl-drop-spec §7 + user feedback:
        //   - ↕ 平倉反手 is a POSITION-level action (close & reverse),
        //     not bracket-state-dependent. Visible whenever a position
        //     is open, regardless of phase.
        //   - +TP / +SL drop sources: visible during proposal phases
        //     (pending / editing / armed-with-empty-leg) when the
        //     corresponding leg has no price.
        //   - 確認 / 捨棄: visible only when there's something to
        //     confirm — at least one leg has a price AND we're in a
        //     pre-armed phase.
        //   - The whole group's container shows whenever ANY of those
        //     buttons would be visible. Since ↕ is always-on while a
        //     position exists, that resolves to "group visible iff
        //     position open".
        const tpEmpty = !Number.isFinite(ps.tp);
        const slEmpty = !Number.isFinite(ps.sl);
        const groupVisible = !!pos;       // ↕ keeps it open for any position
        if (this._actionsEl) this._actionsEl.hidden = !groupVisible;

        // Per-button visibility within the group.
        const setBtnHidden = (sel, hidden) => {
          if (!this._actionsEl) return;
          const btn = this._actionsEl.querySelector(sel);
          if (btn) btn.hidden = hidden;
        };
        setBtnHidden('.sim-inline-discard', !actionsVisible);
        setBtnHidden('.sim-inline-confirm', !actionsVisible);
        setBtnHidden('.sim-inline-flip', !groupVisible);
        // Drop sources only meaningful during an active proposal — once
        // the position is closed (or in some other terminal state) they
        // hide. While in proposal, hide per-leg once it has a price.
        setBtnHidden('.sim-leg-drop.tp', !inProposal || !tpEmpty);
        setBtnHidden('.sim-leg-drop.sl', !inProposal || !slEmpty);

        // Confirm-button gating.
        const inlineConf = this._actionsEl && this._actionsEl.querySelector('.sim-inline-confirm');
        if (inlineConf) {
          if (ps && ps.validity && ps.validity.canConfirm) {
            inlineConf.removeAttribute('disabled');
          } else {
            inlineConf.setAttribute('disabled', 'disabled');
          }
        }
      }

      // ---- Vertical rail + 3 dots --------------------------------
      // Container `[hidden]` reflects whether the rail makes sense AT ALL
      // (proposal active + at least one leg + not armed). The actual
      // line / dot opacity is hover/drag-driven via `.sim-rail-visible`
      // on the same container — see _updateRailVisibility (spec §3).
      const rail = this._railEl;
      if (rail) {
        const railEligible = inProposal && ps.phase !== 'armed'
          && (Number.isFinite(ps.tp) || Number.isFinite(ps.sl));
        rail.hidden = !railEligible;
        if (railEligible) {
          const setDot = (dotEl, price, leg) => {
            if (!dotEl) return;
            const y = yOf(price);
            if (!Number.isFinite(price) || y == null) {
              dotEl.hidden = true;
              dotEl.classList.remove('dragging');
              return;
            }
            dotEl.hidden = false;
            dotEl.style.top = y + 'px';
            if (leg && ps.draggingLeg === leg) dotEl.classList.add('dragging');
            else                                dotEl.classList.remove('dragging');
          };
          setDot(this._railDotTp,    ps.tp, 'tp');
          setDot(this._railDotEntry, pos.avgEntryPrice, null);
          setDot(this._railDotSl,    ps.sl, 'sl');
        }
        // Re-evaluate hover/drag visibility — phase changes (e.g. confirm
        // → armed) demand the rail fully hide regardless of hover state.
        this._updateRailVisibility();
      }
    },

    /** ✕ glyph handler on TP/SL tickets — return that leg to `empty`
     *  state so the +TP / +SL drop button reappears. Per tp-sl-drop-spec
     *  §6: instead of toggling a checkbox (the side-panel toggle is
     *  gone), null the leg directly and refresh.
     *
     *  No-op outside an active proposal. For committed positions,
     *  cancellation needs `eng.cancelOrder` plumbing — deferred. */
    _cancelLegFromTicket(leg) {
      const ps = this.proposalState;
      if (!ps.active) return;
      // Re-arm phase machine if user is editing an armed leg.
      if (ps.phase === 'armed' && this._enterEditingPhase) {
        this._enterEditingPhase();
      }
      ps[leg] = null;
      this.refreshValidity();
      this.refresh();
      if (window.SimOverlays && window.SimOverlays.sync) {
        window.SimOverlays.sync();
      }
    },

    /** Make a TP/SL ticket vertically draggable. Mousedown on the ticket
     *  (anywhere except the ✕ button, which has its own handler that
     *  stops propagation) starts the drag; document mousemove converts
     *  the cursor's Y into a price via `chart.convertFromPixel`, snaps
     *  to tickSize, writes back to `ps[leg]`, and triggers a sync so
     *  the line / band / rail-dot all follow.
     *
     *  Replaces KLineChart's old canvas drag (which was attached to
     *  `performEventPressedMove` on the default point figure). The
     *  canvas figure is now off (`needDefaultPointFigure: false`) so
     *  there's no separate floating circle to mismatch the ticket's X. */
    _wireTicketDrag(ticketEl, leg) {
      if (!ticketEl) return;
      let onMove = null, onUp = null;

      ticketEl.addEventListener('mousedown', (e) => {
        // ✕ has its own click handler (and stops propagation); skip if
        // the mousedown landed on it. Defensive — covers any path where
        // stopPropagation wasn't reached.
        if (e.target.closest && e.target.closest('.seg-x')) return;
        const ps = this.proposalState;
        if (!ps.active || !Number.isFinite(ps[leg])) return;
        e.preventDefault();
        e.stopPropagation();

        // Armed → editing transition on first drag. Same logic the old
        // canvas drag handler had, kept here so post-confirm tweaks
        // re-show the 確認/捨棄 buttons and band visuals.
        if (ps.phase === 'armed' && this._enterEditingPhase) {
          this._enterEditingPhase();
        }
        this._setDragging(leg);
        ticketEl.classList.add('dragging');

        const chartArea = document.getElementById('chart-area');
        const spec = Controller.spec || {};
        const tickSize = spec.tickSize || 0.25;

        onMove = (ev) => {
          const chart = (window.App && window.App.chart) || null;
          if (!chart || !chart.convertFromPixel) return;
          const rect = chartArea.getBoundingClientRect();
          const y = ev.clientY - rect.top;
          try {
            const pt = chart.convertFromPixel(
              { x: 0, y },
              { paneId: 'candle_pane' }
            );
            const data = Array.isArray(pt) ? pt[0] : pt;
            const price = data && data.value;
            if (!Number.isFinite(price)) return;
            const snapped = Math.round(price / tickSize) * tickSize;
            ps[leg] = snapped;
            // Mirror to the side-panel input so both editors stay in sync.
            const inp = document.getElementById(`sim-pos-${leg}`);
            if (inp && document.activeElement !== inp) {
              inp.value = snapped.toFixed(2);
            }
            this.refreshValidity();
            this.refresh();
            if (window.SimOverlays && window.SimOverlays.sync) {
              window.SimOverlays.sync();
            }
          } catch (err) { /* convert error — ignore */ }
        };
        onUp = () => {
          this._setDragging(null);
          ticketEl.classList.remove('dragging');
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('mouseup',   onUp,   true);
          onMove = null; onUp = null;
        };
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup',   onUp,   true);
      });
    },

    // ------------------------------------------------------------------
    // Leg-drop affordance — tp-sl-drop-spec §2 / §3
    //   _beginLegDrop      mousedown on +TP / +SL spawns the ghost +
    //                      registers doc-level move/up/keydown
    //   _updateLegDropPrice mousemove → snapped price + ghost amount
    //   _cancelLegDrop      ESC or out-of-bounds release → revert leg
    // ------------------------------------------------------------------

    _beginLegDrop(leg, evt) {
      evt.preventDefault();
      evt.stopPropagation();
      const ps = this.proposalState;
      // No active proposal → drag has nowhere to land. Defensive: drop
      // buttons should already be hidden when no position is open.
      if (!ps.active) return;
      // Re-arm phase machine if user grabs into an armed state.
      // Mirrors the same gesture for re-grabbing an existing TP/SL handle.
      if (ps.phase === 'armed' && this._enterEditingPhase) {
        this._enterEditingPhase();
      }

      const chartArea = document.getElementById('chart-area');
      if (!chartArea) return;
      const spec = Controller.spec || {};
      const tickSize = spec.tickSize || 0.25;

      const ghost = this._legGhostEl;
      if (ghost) {
        ghost.dataset.leg = leg;
        const nameEl = ghost.querySelector('.leg-name');
        if (nameEl) nameEl.textContent = leg.toUpperCase();
        const amtEl = ghost.querySelector('.amount');
        if (amtEl) amtEl.textContent = (leg === 'tp' ? '+ ' : '- ') + '0.00 ' + (spec.currency || 'USD');
        ghost.style.left = evt.clientX + 'px';
        ghost.style.top  = evt.clientY + 'px';
        ghost.hidden = false;
      }
      const srcBtn = this._actionsEl
        ? this._actionsEl.querySelector(`.sim-leg-drop[data-leg="${leg}"]`)
        : null;
      if (srcBtn) srcBtn.classList.add('dragging');
      document.body.style.cursor = 'grabbing';

      // Compute initial price from mousedown coords so a click-with-no-
      // movement still drops at SOMETHING reasonable.
      this._updateLegDropPrice(leg, evt, tickSize, chartArea);
      // Mark dragging — drives rail visibility + canvas band tint.
      this._setDragging(leg);

      let cancelled = false;

      const onMove = (e) => {
        if (cancelled) return;
        if (ghost) {
          ghost.style.left = e.clientX + 'px';
          ghost.style.top  = e.clientY + 'px';
        }
        this._updateLegDropPrice(leg, e, tickSize, chartArea);
      };

      const cleanup = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup',   onUp,   true);
        document.removeEventListener('keydown',   onKey,  true);
        document.body.style.cursor = '';
        if (srcBtn) srcBtn.classList.remove('dragging');
        if (ghost) ghost.hidden = true;
      };

      const onUp = (e) => {
        cleanup();
        if (cancelled) return;   // ESC path already reset state via onKey
        // Out-of-bounds release → cancel per spec § "Drag past the
        // chart edge". Don't drop legs in random parts of the page.
        const rect = chartArea.getBoundingClientRect();
        const inside = (
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top  && e.clientY <= rect.bottom
        );
        if (!inside) { this._cancelLegDrop(leg); return; }

        // Drop committed — leg already has price from the last
        // _updateLegDropPrice call. Trigger drop animation, clear
        // dragging flag, and refresh the bracket UI.
        this._setDragging(null);
        const ticket = leg === 'tp' ? this._ticketTp : this._ticketSl;
        if (ticket) {
          ticket.classList.remove('dropping');
          // Force reflow so re-adding the class restarts the animation
          // (otherwise back-to-back drops on the same leg skip the anim).
          void ticket.offsetWidth;
          ticket.classList.add('dropping');
          ticket.addEventListener('animationend', () => {
            ticket.classList.remove('dropping');
          }, { once: true });
        }
        this.refresh();
        if (window.SimOverlays && window.SimOverlays.sync) {
          window.SimOverlays.sync();
        }
      };

      const onKey = (e) => {
        if (e.key !== 'Escape') return;
        cancelled = true;
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        this._cancelLegDrop(leg);
      };

      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup',   onUp,   true);
      document.addEventListener('keydown',   onKey,  true);
    },

    /** Convert the cursor's Y to a snapped price, write it onto
     *  proposalState[leg], update the ghost's USD amount label, and
     *  trigger a UI refresh so the canvas band + ticket follow.
     *  No-ops silently if the chart isn't ready or convertFromPixel
     *  fails (during a quick drag start before init completes). */
    _updateLegDropPrice(leg, evt, tickSize, chartArea) {
      const chart = (window.App && window.App.chart) || null;
      if (!chart || !chart.convertFromPixel) return;
      const rect = chartArea.getBoundingClientRect();
      // Clamp to pane bounds so dragging above/below the chart still
      // resolves to a price (the topmost / bottommost visible row).
      const y = Math.max(0, Math.min(rect.height, evt.clientY - rect.top));
      let price;
      try {
        const pt = chart.convertFromPixel({ x: 0, y }, { paneId: 'candle_pane' });
        const data = Array.isArray(pt) ? pt[0] : pt;
        price = data && data.value;
      } catch (e) { return; }
      if (!Number.isFinite(price)) return;
      const snapped = Math.round(price / tickSize) * tickSize;
      const ps = this.proposalState;
      ps[leg] = snapped;

      // Update ghost amount label using the spec § "USD impact"
      // formula: signed pts (per leg semantic), abs USD, fixed prefix
      // (+ for TP, - for SL).
      const ghost = this._legGhostEl;
      if (ghost) {
        const eng = Controller.engine;
        const pos = eng && eng.getPositions()[0];
        const amtEl = ghost.querySelector('.amount');
        if (amtEl && pos) {
          const spec = Controller.spec || {};
          const pv  = spec.pointValue || 1;
          const lot = spec.lotSize    || 1;
          const entry = pos.avgEntryPrice;
          const signedPts = (leg === 'tp')
            ? (pos.side === 'long' ? snapped - entry : entry - snapped)
            : (pos.side === 'long' ? entry - snapped : snapped - entry);
          const usd = Math.abs(signedPts) * pos.qty * pv * lot;
          const prefix = leg === 'tp' ? '+ ' : '- ';
          amtEl.textContent = prefix + usd.toFixed(2) + ' ' + (spec.currency || 'USD');
        }
      }

      this.refreshValidity();
      this.refresh();
      if (window.SimOverlays && window.SimOverlays.sync) {
        window.SimOverlays.sync();
      }
    },

    /** ESC during drag, or release outside chart bounds. Spec § "ESC
     *  during drag": null the leg, no phase change, no other-leg
     *  effect. */
    _cancelLegDrop(leg) {
      const ps = this.proposalState;
      ps[leg] = null;
      this._setDragging(null);
      this.refreshValidity();
      this.refresh();
      if (window.SimOverlays && window.SimOverlays.sync) {
        window.SimOverlays.sync();
      }
    },

    // ------------------------------------------------------------------
    // Pending-order DOM tickets (limit / stop / stop-limit) — rebuilt on
    // every Overlays.sync(); positions tracked by _syncTicketPositions
    // every rAF tick so they ride zoom/pan without detaching from the
    // dashed price line.
    // ------------------------------------------------------------------

    /** Diff-rebuild the pending-order ticket DOM list to match the
     *  engine's currently-active non-bracket pending orders. Called
     *  from Overlays.sync() whenever the order set changes. */
    _syncPendingTickets() {
      const container = this._pendingTicketsEl;
      if (!container) return;
      const eng = Controller.engine;
      // Helper: a draft ticket may exist independently of any engine
      // order — its DOM lives in the same container. Don't blow it
      // away when the engine has no orders.
      const hasDraft = !!(this._draftPending && this._draftPending._ticketEl);
      if (!eng) {
        if (hasDraft) {
          container.hidden = false;
        } else {
          container.hidden = true;
          container.innerHTML = '';
        }
        return;
      }
      // Top-level non-market active pending orders. Bracket children
      // (TP/SL legs of an open position) are owned by the band/ticket
      // system in _syncBracketTickets — skip them here.
      const orders = eng.getPendingOrders().filter(o =>
        o.active && o.type !== 'market' && !o.bracketParentId
      );
      if (!orders.length) {
        if (hasDraft) {
          container.hidden = false;
          // Remove engine tickets, keep draft.
          for (const child of Array.from(container.children)) {
            if (child.dataset.state !== 'draft') container.removeChild(child);
          }
        } else {
          container.hidden = true;
          container.innerHTML = '';
        }
        return;
      }
      container.hidden = false;

      const wantIds = new Set(orders.map(o => String(o.id)));
      // Remove tickets whose backing order is gone (cancelled / filled).
      // Skip draft tickets — they have no orderId and are managed by
      // _commitDraftToEngine / _cancelDraft, not the engine sync.
      for (const child of Array.from(container.children)) {
        if (child.dataset.state === 'draft') continue;
        if (!wantIds.has(child.dataset.orderId)) {
          container.removeChild(child);
        }
      }
      // Add / update for each wanted order.
      for (const order of orders) {
        let el = container.querySelector(
          `.sim-pending-ticket[data-order-id="${order.id}"]`);
        if (!el) {
          el = this._createPendingTicketEl(order);
          container.appendChild(el);
        }
        this._updatePendingTicketEl(el, order);
      }
    },

    /** Build a fresh pending-ticket DOM element for a new order. The
     *  layout is `[side button] [« qty] [type] [×]` — same structure
     *  as the entry ticket but with a single colored side button on
     *  the left instead of the [↕][捨棄][確認] action group. */
    _createPendingTicketEl(order) {
      const el = document.createElement('div');
      el.className = 'sim-pending-ticket ' + (order.side === 'buy' ? 'buy' : 'sell');
      el.dataset.orderId = String(order.id);
      // Three-state machine (data-state attribute drives CSS visibility):
      //   draft    — pre-engine: 買入/賣出 button bright, line/body dimmer
      //   active   — engine has order: button hidden, line/body bright
      //   editing  — drag in progress on active: 確認/捨棄 visible
      // Engine-backed tickets ALWAYS start in 'active'.
      el.dataset.state = 'active';
      const t_ = (window.I18n && window.I18n.t) || ((k) => k);
      el.innerHTML = `
        <button class="pt-side-btn" type="button" tabindex="-1"></button>
        <button class="pt-discard" type="button" tabindex="-1">${t_('sim.btnDiscard')}</button>
        <button class="pt-confirm" type="button" tabindex="-1">${t_('sim.btnConfirm')}</button>
        <div class="pt-body">
          <div class="seg seg-qty" title="${t_('sim.tooltipDragPrice')}"><span class="chev">«</span><span class="qty">1</span></div>
          <div class="seg seg-type"><span class="type-label"></span></div>
          <button class="seg seg-x" type="button" tabindex="-1" title="${t_('sim.tooltipCancelOrder')}">×</button>
        </div>
      `;
      // ✕ → cancel order
      const xBtn = el.querySelector('.seg-x');
      if (xBtn) xBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(el.dataset.orderId, 10);
        if (Number.isFinite(id)) Controller.cancelOrder(id);
      });
      // 確認 → commit dragged price to engine via modifyOrder, exit editing
      const confirmBtn = el.querySelector('.pt-confirm');
      if (confirmBtn) confirmBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._confirmTicketEdit(el);
      });
      // 捨棄 → revert to last-committed price, exit editing
      const discardBtn = el.querySelector('.pt-discard');
      if (discardBtn) discardBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._discardTicketEdit(el);
      });
      // Side button (only visible in 'draft' state) is wired by the
      // draft creation path (_renderDraftTicket); for engine-backed
      // tickets the button is hidden via CSS so this no-op is fine.
      // Whole-ticket vertical drag to modify limit / stop price
      this._wirePendingTicketDrag(el);
      return el;
    },

    /** Update the side-button label / qty / type label / side classes
     *  for an existing ticket DOM (price-Y is handled separately by
     *  _syncTicketPositions on every rAF). */
    _updatePendingTicketEl(el, order) {
      el.classList.toggle('buy',  order.side === 'buy');
      el.classList.toggle('sell', order.side === 'sell');
      const t_ = (window.I18n && window.I18n.t) || ((k) => k);
      const sideBtn = el.querySelector('.pt-side-btn');
      if (sideBtn) sideBtn.textContent = order.side === 'buy' ? t_('sim.btnBuy') : t_('sim.btnSell');
      const qtyEl = el.querySelector('.qty');
      if (qtyEl) qtyEl.textContent = String(order.qty);
      const _typeKeys = { limit: 'sim.typeLimit', stop: 'sim.typeStop', stop_limit: 'sim.typeStopLimit' };
      const typeLabel = _typeKeys[order.type] ? t_(_typeKeys[order.type]) : order.type;
      const typeEl = el.querySelector('.type-label');
      if (typeEl) typeEl.textContent = typeLabel;
    },

    /** Wire vertical drag on the « segment of a pending-order ticket.
     *  Mouse Y → convertFromPixel → engine.modifyOrder({ price |
     *  stopPrice }) with snap-to-tickSize.
     *
     *  Per user spec — only the «1 cell is the drag handle. The
     *  side button (買入/賣出) and 限價/停損 label are click/display
     *  targets, not drag affordances. ✕ has its own click handler
     *  to cancel the order. */
    _wirePendingTicketDrag(ticketEl) {
      const grabHandle = ticketEl.querySelector('.seg-qty');
      if (!grabHandle) return;
      let onMove = null, onUp = null;
      grabHandle.addEventListener('mousedown', (e) => {
        // DRAFT-state ticket has no orderId — drag adjusts the local
        // _draftPending state. Engine is untouched.
        if (ticketEl.dataset.state === 'draft') {
          this._handleDraftDragStart(ticketEl, e);
          return;
        }
        const orderId = parseInt(ticketEl.dataset.orderId, 10);
        if (!Number.isFinite(orderId)) return;
        const eng = Controller.engine;
        const order = eng && eng.getOrder(orderId);
        if (!order || order.status !== 'pending') return;
        e.preventDefault();
        e.stopPropagation();
        ticketEl.classList.add('dragging');
        // Per user spec — drag on an ACTIVE ticket enters EDITING phase.
        // The engine ISN'T modified live; instead the new price is
        // staged on the ticket's dataset until the user clicks 確認
        // (commit via modifyOrder) or 捨棄 (revert local change).
        // Snapshot the original price so 捨棄 can restore it.
        if (ticketEl.dataset.state !== 'editing') {
          ticketEl.dataset.state = 'editing';
          ticketEl.dataset.originalPrice = String(
            order.type === 'stop' ? order.stopPrice : order.price);
        }
        const chartArea = document.getElementById('chart-area');
        const spec = Controller.spec || {};
        const tickSize = spec.tickSize || 0.25;

        onMove = (ev) => {
          const chart = (window.App && window.App.chart) || null;
          if (!chart || !chart.convertFromPixel) return;
          const rect = chartArea.getBoundingClientRect();
          const y = ev.clientY - rect.top;
          try {
            const pt = chart.convertFromPixel(
              { x: 0, y },
              { paneId: 'candle_pane' }
            );
            const data = Array.isArray(pt) ? pt[0] : pt;
            const price = data && data.value;
            if (!Number.isFinite(price)) return;
            const snapped = Math.round(price / tickSize) * tickSize;
            // Stage the new price on the ticket — does NOT call
            // engine.modifyOrder. Only the canvas-line overlay's
            // anchor point gets updated for visual feedback while
            // dragging. The actual engine modification happens on
            // 確認 click via _confirmTicketEdit.
            ticketEl.dataset.stagedPrice = String(snapped);
            // Push the staged price to the canvas overlay so the dashed
            // line follows the ticket LIVE — without this it'd stay at
            // the engine's order.price until 確認 was clicked, which
            // looked like the line "jumped" only on commit.
            if (window.SimOverlays && window.SimOverlays.previewOrderPrice) {
              window.SimOverlays.previewOrderPrice(orderId, snapped);
            }
            // Move the ticket to the dragged Y immediately for visual.
            const yPx = (() => {
              try {
                const px = chart.convertToPixel(
                  [{ timestamp: Date.now(), value: snapped }],
                  { paneId: 'candle_pane' }
                );
                return Array.isArray(px) ? (px[0] && px[0].y) : (px && px.y);
              } catch (err) { return null; }
            })();
            if (Number.isFinite(yPx)) ticketEl.style.top = yPx + 'px';
          } catch (err) { /* ignore convert errors */ }
        };
        onUp = () => {
          ticketEl.classList.remove('dragging');
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('mouseup',   onUp,   true);
          onMove = null; onUp = null;
        };
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup',   onUp,   true);
      });
    },

    /** Commit the EDITING ticket's staged price to the engine and
     *  transition the ticket back to ACTIVE state. Idempotent if no
     *  edit was staged (no-op). */
    _confirmTicketEdit(ticketEl) {
      const orderId = parseInt(ticketEl.dataset.orderId, 10);
      if (!Number.isFinite(orderId)) return;
      const staged = parseFloat(ticketEl.dataset.stagedPrice);
      const eng = Controller.engine;
      const order = eng && eng.getOrder(orderId);
      if (Number.isFinite(staged) && order && order.status === 'pending') {
        if (order.type === 'stop') {
          eng.modifyOrder(orderId, { stopPrice: staged });
        } else {
          eng.modifyOrder(orderId, { price: staged });
        }
        Controller._markDirty();
      }
      ticketEl.dataset.state = 'active';
      delete ticketEl.dataset.stagedPrice;
      delete ticketEl.dataset.originalPrice;
      // Clear the live drag-preview before sync so the line reads from
      // the (now-modified) engine value rather than the cached preview.
      if (window.SimOverlays && window.SimOverlays.previewOrderPrice) {
        window.SimOverlays.previewOrderPrice(orderId, null);
      }
      // Refresh visuals so canvas line snaps to the committed price.
      if (window.SimOverlays && window.SimOverlays.sync) window.SimOverlays.sync();
      this._renderPendingList();
    },

    /** Discard the EDITING ticket's staged price — engine stays at
     *  the original price; ticket Y snaps back via the next position
     *  sync (rAF picks up the engine's unchanged value). */
    _discardTicketEdit(ticketEl) {
      const orderId = parseInt(ticketEl.dataset.orderId, 10);
      ticketEl.dataset.state = 'active';
      delete ticketEl.dataset.stagedPrice;
      delete ticketEl.dataset.originalPrice;
      // Drop the drag preview so the dashed line snaps back to the
      // engine's unchanged price on the next sync.
      if (Number.isFinite(orderId)
          && window.SimOverlays && window.SimOverlays.previewOrderPrice) {
        window.SimOverlays.previewOrderPrice(orderId, null);
      }
      // Position sync rAF will reset top from engine on next frame —
      // no explicit move needed since order.price is unchanged.
      if (window.SimOverlays && window.SimOverlays.sync) window.SimOverlays.sync();
    },

    // ==================================================================
    // Limit-order DRAFT mode (per user spec — "按下買入前還不會以限價進單")
    //
    // Flow:
    //   panel 限價 + qty + price + 買入 click
    //     → submit() routes non-market types here, NOT to engine
    //     → _createDraftPending stores { side, type, qty, price, stopPrice }
    //       in this._draftPending and renders a chart-side ticket with
    //       data-state="draft" + a dimmed canvas line (extendData.draft=true)
    //   on the chart, side button (買入/賣出) is bright + clickable
    //     → click → _commitDraftToEngine: clears draft, calls engine.placeOrder
    //   ✕ on draft → _cancelDraft: clears state + DOM
    //   « drag on draft → _handleDraftDragStart: updates draft.price locally
    //
    // Only one draft at a time — placing a new draft cancels the old.
    // ==================================================================

    _createDraftPending({ side, type, qty, price, stopPrice }) {
      // Replace any existing draft (one at a time policy).
      this._cancelDraft();
      this._draftPending = {
        side, type, qty,
        price: Number.isFinite(price) ? price : null,
        stopPrice: Number.isFinite(stopPrice) ? stopPrice : null,
      };
      this._renderDraftLine();
      this._renderDraftTicket();
      // Position the ticket immediately so it doesn't appear at top:0px
      // before the next rAF.
      this._syncTicketPositions();
    },

    /** Render the dashed price line as a canvas overlay with
     *  extendData.draft=true so sim_overlays.js paints it dim. */
    _renderDraftLine() {
      const draft = this._draftPending;
      if (!draft) return;
      const chart = (window.App && window.App.chart) || null;
      if (!chart || !chart.createOverlay) return;
      // Anchor X to the latest bar's timestamp so the line is on the
      // chart's data axis (auto-tracks pan/zoom). The actual line
      // visual spans the full width regardless via the figure builder.
      const latest = Controller.getLatestBar && Controller.getLatestBar();
      const ts = latest ? latest.timestamp : Date.now();
      const lineY = (draft.type === 'stop') ? draft.stopPrice : draft.price;
      try {
        const id = chart.createOverlay({
          name: 'sim_pending_order',
          points: [{ timestamp: ts, value: lineY }],
          extendData: {
            side: draft.side,
            type: draft.type,
            draft: true,
          },
        });
        if (id) draft._overlayId = id;
      } catch (e) { /* ignore */ }
    },

    /** Render the DOM ticket for the draft (sits in the same container
     *  as engine pending tickets but has no orderId; data-state="draft"
     *  drives the dimmer styling + visible 買入/賣出 button). */
    _renderDraftTicket() {
      const container = this._pendingTicketsEl;
      const draft = this._draftPending;
      if (!container || !draft) return;
      container.hidden = false;
      const el = document.createElement('div');
      el.className = 'sim-pending-ticket draft ' + draft.side;
      el.dataset.state = 'draft';     // CSS hooks
      el.dataset.draft = 'true';
      const t_ = (window.I18n && window.I18n.t) || ((k) => k);
      el.innerHTML = `
        <button class="pt-side-btn" type="button" tabindex="-1"></button>
        <button class="pt-discard" type="button" tabindex="-1">${t_('sim.btnDiscard')}</button>
        <button class="pt-confirm" type="button" tabindex="-1">${t_('sim.btnConfirm')}</button>
        <div class="pt-body">
          <div class="seg seg-qty" title="${t_('sim.tooltipDragPrice')}"><span class="chev">«</span><span class="qty">1</span></div>
          <div class="seg seg-type"><span class="type-label"></span></div>
          <button class="seg seg-x" type="button" tabindex="-1" title="${t_('sim.tooltipCancelDraft')}">×</button>
        </div>
      `;
      // Populate text
      const sideBtn = el.querySelector('.pt-side-btn');
      sideBtn.textContent = draft.side === 'buy' ? t_('sim.btnBuy') : t_('sim.btnSell');
      el.querySelector('.qty').textContent = String(draft.qty);
      const _typeKeys = { limit: 'sim.typeLimit', stop: 'sim.typeStop', stop_limit: 'sim.typeStopLimit' };
      el.querySelector('.type-label').textContent =
        _typeKeys[draft.type] ? t_(_typeKeys[draft.type]) : draft.type;
      // Click 買入/賣出 → commit draft
      sideBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._commitDraftToEngine();
      });
      // ✕ → cancel draft
      el.querySelector('.seg-x').addEventListener('click', (e) => {
        e.stopPropagation();
        this._cancelDraft();
      });
      // Drag « → update local draft price (no engine involvement yet)
      this._wirePendingTicketDrag(el);
      container.appendChild(el);
      this._draftPending._ticketEl = el;
    },

    /** Mousedown on draft « segment — update _draftPending.price as the
     *  user drags vertically. NO engine calls; the pending order
     *  doesn't exist yet. */
    _handleDraftDragStart(ticketEl, downEvent) {
      const draft = this._draftPending;
      if (!draft) return;
      downEvent.preventDefault();
      downEvent.stopPropagation();
      ticketEl.classList.add('dragging');
      const chartArea = document.getElementById('chart-area');
      const spec = Controller.spec || {};
      const tickSize = spec.tickSize || 0.25;

      const onMove = (ev) => {
        const chart = (window.App && window.App.chart) || null;
        if (!chart || !chart.convertFromPixel) return;
        const rect = chartArea.getBoundingClientRect();
        const y = ev.clientY - rect.top;
        try {
          const pt = chart.convertFromPixel({ x: 0, y }, { paneId: 'candle_pane' });
          const data = Array.isArray(pt) ? pt[0] : pt;
          const price = data && data.value;
          if (!Number.isFinite(price)) return;
          const snapped = Math.round(price / tickSize) * tickSize;
          // Update draft state — for stop / stop_limit the dragged level
          // is the stop trigger; for limit it's the limit price.
          if (draft.type === 'stop') draft.stopPrice = snapped;
          else                        draft.price = snapped;
          // Update the canvas line overlay to track
          if (draft._overlayId && chart.overrideOverlay) {
            const latest = Controller.getLatestBar && Controller.getLatestBar();
            const ts = latest ? latest.timestamp : Date.now();
            const lineY = (draft.type === 'stop') ? draft.stopPrice : draft.price;
            try { chart.overrideOverlay({
              id: draft._overlayId,
              points: [{ timestamp: ts, value: lineY }],
            }); } catch (e2) {}
          }
          // Position the ticket vertically for immediate feedback
          const yPx = (() => {
            try {
              const lineY = (draft.type === 'stop') ? draft.stopPrice : draft.price;
              const px = chart.convertToPixel(
                [{ timestamp: Date.now(), value: lineY }],
                { paneId: 'candle_pane' }
              );
              return Array.isArray(px) ? (px[0] && px[0].y) : (px && px.y);
            } catch (e2) { return null; }
          })();
          if (Number.isFinite(yPx)) ticketEl.style.top = yPx + 'px';
        } catch (err) { /* ignore */ }
      };
      const onUp = () => {
        ticketEl.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup',   onUp,   true);
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup',   onUp,   true);
    },

    /** Click 買入/賣出 on a draft → engine.placeOrder + cleanup draft
     *  state. The engine-side _syncPendingTickets will then render the
     *  ACTIVE ticket on the next sync. */
    _commitDraftToEngine() {
      const draft = this._draftPending;
      if (!draft) return;
      // Tear down draft visuals BEFORE calling placeOrder so we don't
      // briefly have two tickets on screen during the engine sync.
      const overlayId = draft._overlayId;
      const ticketEl  = draft._ticketEl;
      this._draftPending = null;
      if (overlayId && window.App && window.App.chart) {
        try { window.App.chart.removeOverlay(overlayId); } catch (e) {}
      }
      if (ticketEl && ticketEl.parentNode) {
        ticketEl.parentNode.removeChild(ticketEl);
      }
      // Hand to engine. SimController.placeOrder applies the same-bar
      // defer rule via atBarTs, so the active ticket appears as pending
      // (per earlier fix), not insta-filled.
      Controller.placeOrder({
        side: draft.side,
        type: draft.type,
        qty: draft.qty,
        price: draft.price,
        stopPrice: draft.stopPrice,
      });
    },

    /** Tear down the current draft (× click or replaced by new draft). */
    _cancelDraft() {
      const draft = this._draftPending;
      if (!draft) return;
      this._draftPending = null;
      if (draft._overlayId && window.App && window.App.chart) {
        try { window.App.chart.removeOverlay(draft._overlayId); } catch (e) {}
      }
      if (draft._ticketEl && draft._ticketEl.parentNode) {
        draft._ticketEl.parentNode.removeChild(draft._ticketEl);
      }
    },

    /** Enter proposal phase if this is a freshly-opened position
     *  we haven't yet dispositioned. Idempotent — re-running while
     *  already in proposal for the same position is a no-op.
     *
     *  Per tp-sl-drop-spec §1, both legs start `empty` — no
     *  ±0.5% auto-default. The user explicitly drags a +TP / +SL
     *  drop source onto the chart to add a leg. Until they do,
     *  the entry-actions group still shows so the drop buttons
     *  are accessible (spec §7 visibility rule). */
    _maybeStartProposal(pos) {
      if (this._dispositioned.has(pos.id)) return;
      if (this.proposalState.active && this.proposalState.positionId === pos.id) return;
      this.proposalState = {
        active: true,
        positionId: pos.id,
        tp: null,
        sl: null,
        draggingLeg: null,
        // bracket-ux-polish §1: phase + locked-on-confirm state
        phase: 'pending',
        lockedTp: null,
        lockedSl: null,
        validity: { tp: 'disabled', sl: 'disabled', canConfirm: false },
      };
      Overlays.sync();
    },

    /** Set or clear the currently-dragging leg. Called from input
     *  focus / blur AND from the chart-side drag handlers in
     *  sim_overlays.js. The bracket overlay reads this on every sync
     *  to decide whether to fill its band rect or leave just the line. */
    _setDragging(leg) {
      this.proposalState.draggingLeg = leg;     // 'tp' | 'sl' | null
      // Rail stays visible during a drag even if the cursor leaves the
      // ticket — spec §3: showRail = (hoveredCount > 0 || isDragging)
      // && phase !== 'armed'. Without this, releasing the mouse outside
      // the ticket would briefly hide the rail and the dragged dot.
      this._updateRailVisibility();
      Overlays.sync();
    },

    /** bracket-ux-polish §3: toggle the `.sim-rail-visible` class on
     *  the rail container based on hover counter + drag state. CSS
     *  fades the line + dots between opacity 0 and visible (200ms),
     *  so the brief counter == 0 frame between adjacent tickets is
     *  imperceptible. The container itself is shown/hidden by
     *  `_syncBracketTickets` based on phase + leg-enabled — this
     *  method controls only the inner element opacity. */
    _updateRailVisibility() {
      if (!this._railEl) return;
      const ps = this.proposalState;
      const phaseOk = ps.active && ps.phase !== 'armed';
      const isDragging = !!ps.draggingLeg;
      const hovered = (this._hoveredCount || 0) > 0;
      const visible = phaseOk && (hovered || isDragging);
      this._railEl.classList.toggle('sim-rail-visible', visible);
    },

    /** bracket-ux-polish §4: recompute per-leg validity + canConfirm
     *  gate. A TP for a long position must sit ABOVE the latest bar's
     *  high (otherwise it'd fill instantly the moment the user clicks
     *  確認). SL for a long must be BELOW the latest bar's low. Short
     *  is the mirror. Disabled legs are reported as 'disabled' (don't
     *  block confirm).
     *
     *  canConfirm: at least one leg enabled, AND every enabled leg
     *  must be valid. With both enabled, both must be valid.
     *
     *  Idempotent — safe to call from drag handler, panel input
     *  change, replay tick, position open. The renderer / drag
     *  handler should call this BEFORE refreshing the UI so the
     *  confirm button + future warning visuals reflect the new
     *  validity in the same frame. */
    refreshValidity() {
      const ps = this.proposalState;
      const blank = { tp: 'disabled', sl: 'disabled', canConfirm: false };
      if (!ps.active) { ps.validity = blank; return; }
      const eng = Controller.engine;
      const pos = eng && eng.getPositions().find(p => p.id === ps.positionId);
      const bar = Controller.getLatestBar && Controller.getLatestBar();
      if (!pos || !bar) { ps.validity = blank; return; }
      const isLong = pos.side === 'long';
      // Replay placeholders carry stretched high/low purely so KLineChart's
      // Y-axis autoscale stays stable when the user pans into placeholder
      // territory — those high/low values do NOT reflect actual price action.
      // For validity we need the *true* current price, which on a placeholder
      // is open === close === placeholderFillPrice. Without this guard, every
      // proposal sits inside the (artificially-wide) [L, H] range and TP/SL
      // both flag invalid the moment a position opens in replay mode.
      const H = bar._placeholder ? bar.close : bar.high;
      const L = bar._placeholder ? bar.close : bar.low;
      // Strict comparison so a placeholder bar (where H === L) still
      // demands the proposed price to be strictly outside the bar.
      // A leg with `tp == null` (or sl) is `disabled` — doesn't gate
      // confirm; per spec §7, drop sources still show for that leg.
      const tpValid = !Number.isFinite(ps.tp)
        ? 'disabled'
        : (isLong ? (ps.tp > H) : (ps.tp < L)) ? 'valid' : 'invalid';
      const slValid = !Number.isFinite(ps.sl)
        ? 'disabled'
        : (isLong ? (ps.sl < L) : (ps.sl > H)) ? 'valid' : 'invalid';
      const someEnabled = Number.isFinite(ps.tp) || Number.isFinite(ps.sl);
      const enabledOk =
        (tpValid === 'valid' || tpValid === 'disabled') &&
        (slValid === 'valid' || slValid === 'disabled');
      ps.validity = { tp: tpValid, sl: slValid, canConfirm: enabledOk && someEnabled };
    },

    /** Confirm: place TP and / or SL into the engine as bracket
     *  children of the entry order, OCO-link them, then activate +
     *  immediately tick so they can fire on the current bar if in
     *  range. */
    /** Confirm: bracket-ux-polish §1 phase transitions.
     *
     *  pending → armed   (first commit; place engine orders)
     *  editing → armed   (subsequent commit after drag; modify
     *                     existing engine orders or add/remove legs)
     *
     *  In both targets, lockedTp / lockedSl get updated to the
     *  current ps.tp / ps.sl and the proposal stays active (just at
     *  phase 'armed'). Drag-on-armed flips us back to 'editing'. */
    _confirmProposal() {
      const ps = this.proposalState;
      if (!ps.active) return;
      // bracket-ux-polish §4: defensive guard. The button should be
      // disabled by the renderer when canConfirm is false, but if the
      // click somehow lands (keyboard activation, programmatic call,
      // race), drop it here too.
      if (!ps.validity || !ps.validity.canConfirm) return;
      const eng = Controller.engine;
      const pos = eng.getPositions().find(p => p.id === ps.positionId);
      if (!pos) return;

      const oppSide = pos.side === 'long' ? 'sell' : 'buy';
      const parentId = pos.entryOrderIds[0];

      // Existing children (will be present on editing → armed,
      // absent on first pending → armed).
      const existingTp = eng.getPendingOrders().find(
        o => o.bracketParentId === parentId && o.type === 'limit');
      const existingSl = eng.getPendingOrders().find(
        o => o.bracketParentId === parentId && o.type === 'stop');

      // branching-replay-spec §7.5: bracket TP/SL legs inherit the
      // branchId from their parent entry. We read it from the parent
      // order rather than BranchEngine.activeBranchId because the user
      // could in theory have switched branches between filling the
      // parent and confirming the bracket — the bracket should stay
      // attached to whichever branch the entry was placed on.
      const parentOrder = eng.getOrder(parentId);
      const parentBranchId = (parentOrder && parentOrder.branchId) || 'main';

      try {
        // ---- TP ---------------------------------------------------
        if (Number.isFinite(ps.tp)) {
          if (existingTp) {
            eng.modifyOrder(existingTp.id, { price: ps.tp });
          } else {
            const id = eng.placeOrder({
              side: oppSide, type: 'limit', qty: pos.qty,
              price: ps.tp, bracketParentId: parentId,
              branchId: parentBranchId,
            });
            const o = eng.getOrder(id);
            if (o) o.active = true;            // parent already filled
          }
        } else if (existingTp) {
          eng.cancelOrder(existingTp.id);       // leg cleared
        }
        // ---- SL ---------------------------------------------------
        if (Number.isFinite(ps.sl)) {
          if (existingSl) {
            eng.modifyOrder(existingSl.id, { stopPrice: ps.sl });
          } else {
            const id = eng.placeOrder({
              side: oppSide, type: 'stop', qty: pos.qty,
              stopPrice: ps.sl, bracketParentId: parentId,
              branchId: parentBranchId,
            });
            const o = eng.getOrder(id);
            if (o) o.active = true;
          }
        } else if (existingSl) {
          eng.cancelOrder(existingSl.id);
        }
      } catch (e) {
        console.warn('[sim] confirmProposal failed', e.message);
        Panel.flashError(e.message);
        return;
      }

      // OCO link whichever pair currently exists. Re-running this on
      // editing → armed re-binds even if one side was added or
      // dropped this round; ocoSiblingId is just a number, no
      // double-fire problems.
      const finalTp = eng.getPendingOrders().find(
        o => o.bracketParentId === parentId && o.type === 'limit');
      const finalSl = eng.getPendingOrders().find(
        o => o.bracketParentId === parentId && o.type === 'stop');
      if (finalTp && finalSl) {
        finalTp.ocoSiblingId = finalSl.id;
        finalSl.ocoSiblingId = finalTp.id;
      }

      // First-commit-only: stamp the position with the initial
      // proposal for step 6's hindsight-modification tooltip.
      // Subsequent edits don't overwrite — the "initial" is, by
      // definition, the FIRST one.
      if (ps.phase === 'pending') {
        pos.initialTP = Number.isFinite(ps.tp) ? ps.tp : null;
        pos.initialSL = Number.isFinite(ps.sl) ? ps.sl : null;
      }

      // Lock the just-confirmed values. The proposal stays active
      // so the user can edit again later; phase = 'armed' tells the
      // renderer to hide the chart-side buttons / dim the bands.
      ps.lockedTp = Number.isFinite(ps.tp) ? ps.tp : null;
      ps.lockedSl = Number.isFinite(ps.sl) ? ps.sl : null;
      ps.phase = 'armed';
      ps.draggingLeg = null;

      // Tick once so a TP / SL whose price already lies inside the
      // current bar's range fills right away.
      Controller._tickNow();
      Controller._markDirty();
      this.refreshValidity();
      Panel.refresh();
      Overlays.sync();
    },

    /** bracket-ux-polish §1: armed → editing. Called from the
     *  drag handler and panel input/toggle handlers when the user
     *  touches a bracket leg AFTER the bracket has been confirmed.
     *  The locked* values are kept so 捨棄 can revert. */
    _enterEditingPhase() {
      const ps = this.proposalState;
      if (!ps.active) return;
      if (ps.phase !== 'armed') return;
      ps.phase = 'editing';
      // Visuals + button visibility flip on the next refresh.
    },

    /** Discard — branched by phase. Per tp-sl-drop-spec §1 + user
     *  feedback ("捨棄 應該讓 TP/SL 回到 entrypoint 中間重新拉"):
     *
     *  pending  → reset legs to empty, KEEP proposal active so the
     *             +TP / +SL drop buttons remain accessible. The user
     *             can re-drag immediately. Position stays open.
     *  editing  → revert to lockedTp / lockedSl, return to 'armed'.
     *  armed    → no-op (button shouldn't be visible).
     *
     *  We deliberately do NOT add the position id to `_dispositioned`
     *  anymore — that flag would block `_maybeStartProposal` from ever
     *  re-opening the proposal, which is exactly the bug the user
     *  reported (drop buttons vanished forever after 捨棄).
     */
    _discardProposal() {
      const ps = this.proposalState;
      if (!ps.active) return;
      if (ps.phase === 'editing') {
        ps.tp = ps.lockedTp;
        ps.sl = ps.lockedSl;
        ps.phase = 'armed';
        ps.draggingLeg = null;
        this.refreshValidity();
        Panel.refresh();
        Overlays.sync();
        return;
      }
      if (ps.phase === 'armed') return;       // shouldn't be reachable
      // pending → reset legs to empty without tearing down the proposal.
      ps.tp = null;
      ps.sl = null;
      ps.draggingLeg = null;
      this.refreshValidity();
      Panel.refresh();
      Overlays.sync();
    },

    _renderPendingList() {
      const list = document.getElementById('sim-pending-list');
      if (!list) return;
      const orders = Controller.engine.getPendingOrders()
        .filter(o => o.active && !o.bracketParentId);   // top-level only for step 2
      list.innerHTML = '';
      const t_ = (window.I18n && window.I18n.t) || ((k) => k);
      // The single-character badges 買/賣 use the first char of the
      // full Buy / Sell labels — works in both locales (買/賣 → B/S).
      const _typeKeys = {
        market: 'sim.typeMarketShort', limit: 'sim.typeLimit',
        stop:   'sim.typeStop',         stop_limit: 'sim.typeStopLimit',
      };
      for (const o of orders) {
        const row = document.createElement('div');
        row.className = 'sim-pending-row ' + o.side;
        const sideBadge = o.side === 'buy' ? t_('sim.btnBuy').charAt(0) : t_('sim.btnSell').charAt(0);
        const typeLabel = _typeKeys[o.type] ? t_(_typeKeys[o.type]) : o.type;
        const cancelTitle = t_('sim.tooltipCancelOrder');
        row.innerHTML = `
          <span class="badge">${sideBadge}</span>
          <span class="meta">${typeLabel}  ${o.qty}</span>
          <span class="price">${o.type === 'stop' ? o.stopPrice.toFixed(2) : (o.price != null ? o.price.toFixed(2) : '—')}</span>
          <button class="x-btn" title="${cancelTitle}">✕</button>
        `;
        row.querySelector('.x-btn').addEventListener('click', () => {
          Controller.cancelOrder(o.id);
        });
        list.appendChild(row);
      }
    },

    _renderReplayWarning() {
      const warn = document.getElementById('sim-replay-warning');
      if (!warn) return;
      const inReplay = !!(window.Replay && window.Replay.active);
      warn.classList.toggle('hidden', inReplay);
    },

    flashError(msg) {
      // Quick + cheap feedback for now (step 9 polish will toast it).
      console.warn('[sim panel]', msg);
    },
  };

  // ------------------------------------------------------------------
  // Overlays — shim that calls window.SimOverlays.sync(). Keeping the
  // indirection so this file doesn't crash when sim_overlays.js hasn't
  // loaded yet (script ordering edge case in the HTML).
  // ------------------------------------------------------------------
  const Overlays = {
    sync() {
      if (window.SimOverlays && window.SimOverlays.sync) {
        window.SimOverlays.sync();
      }
      // DOM-side pending-order tickets sit alongside the canvas
      // dashed line and need to rebuild whenever the engine's
      // pending-order set changes (placement / cancel / fill).
      if (Panel && Panel._syncPendingTickets) Panel._syncPendingTickets();
    },
  };

  // ------------------------------------------------------------------
  // Expose
  // ------------------------------------------------------------------
  window.SimController = Controller;
  window.SimPanel = Panel;
})();
