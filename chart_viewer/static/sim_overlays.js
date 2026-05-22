/**
 * sim_overlays.js — On-chart overlays for the simulation engine.
 *
 * Three overlay types are registered with KLineChart:
 *
 *   sim_pending_order      Horizontal dashed line at a pending limit /
 *                          stop / stop_limit's price level. Anchored
 *                          on the LEFT at the order's createdAtBar X
 *                          (NOT a full-width chart-spanning line) so
 *                          the line "belongs to" the bar where the
 *                          order was placed, per spec § Chart visual
 *                          markers § Pending-order line geometry.
 *
 *   sim_trade_arrow        Triangle marker on a K-bar's wick at the
 *                          moment of entry / exit fill. Color rule
 *                          (per spec § Chart visual markers):
 *                            long entry  → blue ↑ below low
 *                            long exit   → red  ↓ above high
 *                            short entry → red  ↓ above high
 *                            short exit  → blue ↑ below low
 *
 *   sim_position_duration  Vertical line at the chart's right edge
 *                          spanning from entry-price Y to current-
 *                          price Y. Long = blue, short = red.
 *
 * Sync model: SimController calls SimOverlays.sync() after every state
 * change. We diff against three id maps and add / remove / update
 * KLineChart overlays as needed.
 */
(function () {
  // Per-overlay-class id maps. Keys are deterministic so re-syncing
  // doesn't churn through redundant create / remove cycles.
  //
  //   _pendingIdBy    : Map<orderId, chartOverlayId>
  //   _arrowIdBy      : Map<arrowKey, chartOverlayId>      (arrowKey = `${posId}.entry` or `.exit`)
  //   _durationIdBy   : Map<positionId, chartOverlayId>
  const _pendingIdBy  = new Map();
  // Per-order preview price set by sim_panel during edit-drag, so the
  // canvas dashed line tracks the dragged ticket BEFORE the user clicks
  // 確認 (which is what calls engine.modifyOrder). Cleared by panel
  // on 確認/捨棄. Read inside _syncPendingOrders so any sync that
  // fires mid-drag also paints the previewed value.
  const _orderPreviewPrice = new Map();   // orderId → price
  const _arrowIdBy    = new Map();
  const _durationIdBy = new Map();
  // Mini-chart parallels: trade arrows + position-duration lines on the
  // sub-chart need their own overlay-id maps because both main and mini
  // can render the same posId concurrently (different branches → two
  // separate KLineChart overlays). Keyed by `${posId}.${event}` for
  // arrows, plain posId for duration. Mini-only — pending-order lines
  // and bracket bands stay main-only (they're interactive, dragging
  // them on the read-only mini doesn't make sense).
  const _miniArrowIdBy    = new Map();
  const _miniDurationIdBy = new Map();
  // Bracket bands: keyed by `${positionId}.tp` / `${positionId}.sl` so
  // the TP and SL legs of a position are tracked independently and can
  // be added / removed individually.
  const _bandIdBy     = new Map();
  // Entry line: one full-width horizontal dashed line per open position,
  // sitting at the entry price. Renders in BLUE (#2962ff) to pair with
  // the entry ticket DOM in #sim-bracket-tickets. Keyed by positionId.
  const _entryLineIdBy = new Map();

  let _registered = false;

  // ------------------------------------------------------------------
  // Overlay templates registered with KLineChart
  // ------------------------------------------------------------------
  function _registerTemplates() {
    if (_registered) return;
    if (typeof klinecharts === 'undefined' || !klinecharts.registerOverlay) return;

    klinecharts.registerOverlay({
      name: 'sim_pending_order',
      totalStep: 2,
      lock: true,
      needDefaultPointFigure: false,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: false,
      // Renders ONLY the dashed price line. The TradingView-style
      // ticket badge that used to sit in canvas was moved to DOM
      // (#sim-pending-tickets, driven by sim_panel._syncPendingTickets)
      // so it can be styled with the same 3-segment pill as the entry
      // ticket AND vertically dragged via the « handle to modify the
      // order's price.
      //
      // Line spans the FULL chart width (left edge → right edge),
      // independent of where the placement bar sits. Earlier the line
      // started at `Math.max(0, placementBarX)` so a placement bar
      // visible mid-chart would leave the left half un-drawn — user
      // wanted it always extending to the left edge so the price
      // level reads as a continuous reference line.
      createPointFigures: ({ coordinates, bounding, overlay }) => {
        if (!coordinates || coordinates.length < 1 || !bounding) return [];
        const y = coordinates[0].y;
        const ext = (overlay && overlay.extendData) || {};
        const side = ext.side || 'buy';
        const type = ext.type || 'limit';
        // DRAFT mode (extendData.draft === true): the user hit panel
        // 買入/賣出 with a non-market type but hasn't committed via the
        // chart-side button yet. Render the dashed line at ~45% alpha
        // so it reads as "tentative — not active". Once committed via
        // _commitDraftToEngine, sim_overlays creates a fresh overlay
        // without the draft flag and the line is full brightness.
        const isDraft = !!ext.draft;
        const baseColor = side === 'buy' ? '#2962ff' : '#ef5350';
        const color = isDraft
          ? (side === 'buy' ? 'rgba(41, 98, 255, 0.45)' : 'rgba(239, 83, 80, 0.45)')
          : baseColor;
        const dashedValue = (type === 'stop' || type === 'stop_limit')
          ? [10, 4]      // longer dashes for stops to distinguish
          : [4, 3];

        return [{
          type: 'line',
          attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
          styles: { color, size: 1, style: 'dashed', dashedValue },
        }];
      },
    });

    klinecharts.registerOverlay({
      name: 'sim_trade_arrow',
      totalStep: 2,
      lock: true,
      needDefaultPointFigure: false,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: false,
      createPointFigures: ({ coordinates, overlay }) => {
        if (!coordinates || coordinates.length < 1) return [];
        const cx = coordinates[0].x;
        const baseY = coordinates[0].y;
        const ext = (overlay && overlay.extendData) || {};
        const side = ext.side || 'long';
        const event = ext.event || 'entry';
        // Color rule from spec § Chart visual markers:
        //   long entry, short exit  → blue ↑ (anchored at bar.low, points UP)
        //   long exit, short entry  → red  ↓ (anchored at bar.high, points DOWN)
        const isUp = (side === 'long'  && event === 'entry')
                  || (side === 'short' && event === 'exit');
        // branching-replay-spec §2.1: trades inherited from a parent
        // branch are rendered with reduced alpha so the user can tell
        // "this happened before my fork point, on a parent timeline"
        // apart from "this is a trade I made on the current branch".
        const inherited = !!ext.inherited;
        const color = inherited
          ? (isUp ? 'rgba(41, 98, 255, 0.45)' : 'rgba(239, 83, 80, 0.45)')
          : (isUp ? '#2962ff' : '#ef5350');

        // Arrow geometry — KLineChart canvas Y grows downward.
        // For ↑ (up arrow): tip is the smallest Y; we anchor 4 px below
        // the wick (= larger Y) so the tip sits just under the K-bar.
        // For ↓ (down arrow): symmetric.
        // tp-sl-drop §平倉反手: when several events of the same direction
        // land on the same K-bar (e.g. long exit + short entry from one
        // close-and-reverse fill, or repeated averaging), `ext.stackIndex`
        // is set by the sync layer (0 = closest to wick, 1, 2, ...
        // further away). Each step shifts the whole triangle by PITCH
        // pixels along the away-from-wick axis so the user can read the
        // chronological stack.
        const GAP = 4, LEN = 10, HALF_W = 5;
        const PITCH = LEN + 2;
        const stackIndex = Number.isFinite(ext.stackIndex) ? ext.stackIndex : 0;
        const stackOffset = stackIndex * PITCH;
        let pts;
        if (isUp) {
          // Up arrow lives BELOW the wick. Stacking pushes it further
          // down (larger Y).
          const tipY = baseY + GAP + stackOffset;
          const bottomY = tipY + LEN;
          pts = [
            { x: cx, y: tipY },
            { x: cx - HALF_W, y: bottomY },
            { x: cx + HALF_W, y: bottomY },
          ];
        } else {
          // Down arrow lives ABOVE the wick. Stacking pushes it further
          // up (smaller Y).
          const tipY = baseY - GAP - stackOffset;
          const topY = tipY - LEN;
          pts = [
            { x: cx, y: tipY },
            { x: cx - HALF_W, y: topY },
            { x: cx + HALF_W, y: topY },
          ];
        }
        return [{
          type: 'polygon',
          attrs: { coordinates: pts },
          styles: { style: 'fill', color },
        }];
      },
    });

    // ----- Entry line -----
    //
    // Horizontal dashed line spanning the full chart width at the entry
    // price. Color is side-aware: long → blue (#2962ff), short → red
    // (#ef5350) so the user can tell direction at a glance. Pairs with
    // the entry ticket DOM (rendered separately in #sim-bracket-tickets,
    // which mirrors the same color scheme via the .short modifier class).
    // One per open position, synced in _syncBrackets.
    klinecharts.registerOverlay({
      name: 'sim_entry_line',
      totalStep: 2,
      lock: true,
      needDefaultPointFigure: false,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: false,
      createPointFigures: ({ coordinates, overlay, bounding }) => {
        if (!coordinates || coordinates.length < 1 || !bounding) return [];
        const y = coordinates[0].y;
        const side = (overlay && overlay.extendData && overlay.extendData.side) || 'long';
        const color = side === 'short' ? '#ef5350' : '#2962ff';
        return [{
          type: 'line',
          attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
          styles: { color, size: 1, style: 'dashed', dashedValue: [2, 4] },
        }];
      },
    });

    // ----- Bracket band (TP and SL) -----
    //
    // We register two near-identical templates so each leg can have its
    // own per-leg point color (KLineChart's styles.point is template-
    // wide, not per-overlay). All the figure logic is shared via
    // _buildBracketFigures + _bracketDragHandler.
    //
    // bracket-ux-polish §0 color tokens:
    //   TP green   #089981  (var --sim-tp-color)
    //   SL orange  #ff9800  (var --sim-sl-color)
    // Hardcoded here because KLineChart figures don't read CSS vars.
    _registerBracketTemplate('sim_bracket_band_tp', '#089981');
    _registerBracketTemplate('sim_bracket_band_sl', '#ff9800');

    klinecharts.registerOverlay({
      name: 'sim_position_duration',
      totalStep: 3,
      lock: true,
      needDefaultPointFigure: false,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: false,
      createPointFigures: ({ coordinates, overlay, bounding }) => {
        if (!coordinates || coordinates.length < 2 || !bounding) return [];
        const ext = (overlay && overlay.extendData) || {};
        const side = ext.side || 'long';
        const color = side === 'long' ? '#2962ff' : '#ef5350';
        // Pin to the right edge with a small inset.
        const x = bounding.width - 16;
        const y1 = coordinates[0].y;   // entry price Y
        const y2 = coordinates[1].y;   // current/exit price Y
        return [
          {
            type: 'line',
            attrs: { coordinates: [{ x, y: y1 }, { x, y: y2 }] },
            styles: { color, size: 1, style: 'solid' },
          },
          // Open circles at both ends — TradingView-style endpoint markers.
          {
            type: 'circle',
            attrs: { x, y: y1, r: 3 },
            styles: { style: 'stroke', color, borderColor: color, borderSize: 1 },
          },
          {
            type: 'circle',
            attrs: { x, y: y2, r: 3 },
            styles: { style: 'stroke', color, borderColor: color, borderSize: 1 },
          },
        ];
      },
    });

    _registered = true;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // Bracket template — shared figure builder + drag handler so the TP
  // and SL templates differ only by their `styles.point` color.
  // ------------------------------------------------------------------
  function _registerBracketTemplate(name, accentColor) {
    if (typeof klinecharts === 'undefined' || !klinecharts.registerOverlay) return;
    klinecharts.registerOverlay({
      name,
      totalStep: 2,
      lock: true,                     // no canvas drag — ticket DOM is the drag affordance
      needDefaultPointFigure: false,  // hide the floating circle handle
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: false,
      // No styles.point and no performEventPressedMove — the bracket's
      // drag is now driven entirely from the DOM ticket via
      // Panel._wireTicketDrag (vertical mouse drag on the ticket).
      // This keeps the visual handle and the price line locked at the
      // same X (right:110px) regardless of how the chart is panned.
      createPointFigures: (params) => _buildBracketFigures(params, accentColor),
    });
  }

  /** Shared figure builder for TP / SL bracket bands.
   *
   *  Tickets, warning glyphs, and the warning ring all live in the
   *  DOM now (see #sim-bracket-tickets in index.html and the
   *  Panel._syncBracketTickets driver in sim_panel.js). This builder
   *  only emits the canvas-level visuals: the band fill rect and the
   *  horizontal price line.
   *
   *  bracket-ux-polish §1 visual states (driven by ext.phase + ext.dragging):
   *    pending / editing  + idle      → band 10% fill, dashed 1px line
   *    pending / editing  + dragging  → band 32% fill, dashed 1px line
   *    armed              + idle      → no band,        SOLID 2px line
   *    armed              + dragging  → flipped back to 'editing' by
   *                                     Panel._enterEditingPhase. */
  function _buildBracketFigures({ coordinates, overlay, bounding, yAxis }, accentColor) {
    if (!coordinates || coordinates.length < 1 || !bounding || !yAxis) return [];
    const ext = (overlay && overlay.extendData) || {};
    const dragging = !!ext.dragging;
    const phase    = ext.phase || 'pending';        // 'pending' | 'editing' | 'armed'
    const rgb = _hexToRgbTuple(accentColor);
    const strokeColor = `rgba(${rgb}, 1.00)`;
    // Spec §1: 10% idle, 32% dragging, 0 armed (band gone).
    let bandAlpha;
    if (phase === 'armed') bandAlpha = 0;
    else if (dragging)     bandAlpha = 0.32;
    else                    bandAlpha = 0.10;
    const fillColor = `rgba(${rgb}, ${bandAlpha.toFixed(2)})`;

    const exitY = coordinates[0].y;
    let entryY = exitY;
    if (Number.isFinite(ext.entryPrice) && yAxis.convertToPixel) {
      try { entryY = yAxis.convertToPixel(ext.entryPrice); }
      catch (e) { /* fallback */ }
    }
    const top    = Math.min(entryY, exitY);
    const bot    = Math.max(entryY, exitY);
    const rightX = bounding.width;

    const figures = [];
    if (bandAlpha > 0) {
      figures.push({
        type: 'rect',
        attrs: { x: 0, y: top, width: rightX, height: bot - top },
        styles: { style: 'fill', color: fillColor },
      });
    }
    // Price line: dashed during pending/editing, SOLID when armed.
    if (phase === 'armed') {
      figures.push({
        type: 'line',
        attrs: { coordinates: [{ x: 0, y: exitY }, { x: rightX, y: exitY }] },
        styles: { color: strokeColor, size: 2, style: 'solid' },
      });
    } else {
      figures.push({
        type: 'line',
        attrs: { coordinates: [{ x: 0, y: exitY }, { x: rightX, y: exitY }] },
        styles: { color: strokeColor, size: 1, style: 'dashed', dashedValue: [2, 4] },
      });
    }
    return figures;
  }

  // _bracketDragHandler removed — DOM-side drag in sim_panel.js
  // (Panel._wireTicketDrag) replaces the canvas-driven drag now that
  // bracket templates have lock:true + needDefaultPointFigure:false.

  function _hexToRgbTuple(hex) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    if (!m) return '120, 123, 134';
    return `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}`;
  }

  function _chart() {
    if (window.Drawing && window.Drawing.chart) return window.Drawing.chart;
    if (window.App && window.App.chart) return window.App.chart;
    return null;
  }

  /** Resolve a bar by its timestamp from the engine-relevant source.
   *  In replay mode prefer Replay.displayBars; otherwise App.currentBars.
   *
   *  We accept placeholder bars too: if the user filled a market order
   *  on the very first cursor pick (before any tick), the bar at the
   *  fill timestamp is a placeholder with all OHLC = placeholderFillPrice.
   *  Returning it lets the arrow draw at that price level immediately;
   *  on the next tick the bar materialises into a real K-bar and
   *  _syncTradeArrows re-positions the arrow under the new wick. */
  function _findBarByTimestamp(ts) {
    if (!Number.isFinite(ts)) return null;
    const R = window.Replay;
    let bars = (window.App && window.App.currentBars) || [];
    if (R && R.active && R.displayBars && R.displayBars.length) {
      bars = R.displayBars;
    }
    for (let i = bars.length - 1; i >= 0; i--) {
      const b = bars[i];
      if (b && b.timestamp === ts) {
        // Same normalisation as Controller.getLatestBar: placeholders
        // carry stretched high/low purely for Y-axis stability. Trade-
        // arrow positioning anchors at bar.low (long entry) / bar.high
        // (short entry); without this collapse, a fill-on-placeholder
        // arrow would render at recentLow/recentHigh — way off the
        // actual entry price level.
        if (b._placeholder) {
          return { ...b, high: b.close, low: b.close };
        }
        return b;
      }
    }
    return null;
  }

  function _latestBar() {
    if (window.SimController && window.SimController.getLatestBar) {
      return window.SimController.getLatestBar();
    }
    return null;
  }

  function _orderPriceForLine(o) {
    if (o.type === 'limit' || (o.type === 'stop_limit' && o.triggeredAt != null)) {
      return o.price;
    }
    if (o.type === 'stop')       return o.stopPrice;
    if (o.type === 'stop_limit') return o.stopPrice;
    return null;
  }

  // ------------------------------------------------------------------
  // sync() — reconcile chart overlays against engine state.
  // Called by SimController after every state change.
  // ------------------------------------------------------------------
  function sync() {
    _registerTemplates();
    const eng = window.SimController && window.SimController.engine;
    if (!eng) return;

    // Main chart — full set of overlays. Branch filter defaults to
    // BranchEngine.activeBranchId inside each sub-sync.
    const main = _chart();
    if (main) {
      _syncPendingOrders(main, eng);
      _syncTradeArrows(main, eng);
      _syncPositionDuration(main, eng);
      _syncBrackets(main, eng);
    }

    // Mini chart — read-only subset (trade arrows + position-duration
    // line). Branch filter pinned to BranchEngine.miniBranchId so the
    // sub-pane shows the alt-timeline trades for comparison. We skip
    // entirely when mini is closed (no chart instance) or when no
    // miniBranchId is set (mini chart hidden).
    const Mini = window.MiniChart;
    const Engine = window.BranchEngine;
    const miniBranchId = Engine && Engine.miniBranchId;
    if (Mini && Mini.chart && Mini.el && !Mini.el.hidden && miniBranchId) {
      _syncTradeArrows(Mini.chart, eng, {
        branchId: miniBranchId,
        idBy: _miniArrowIdBy,
      });
      _syncPositionDuration(Mini.chart, eng, {
        branchId: miniBranchId,
        idBy: _miniDurationIdBy,
      });
    } else {
      // Mini closed or no branch set — wipe any stale overlays from
      // the mini chart's overlay-id maps so the next open re-creates
      // them cleanly. KLineChart removeOverlay on a chart that no
      // longer has the overlay is a no-op.
      _wipeMiniOverlays();
    }
  }

  /** Drop every mini-chart overlay we've created. Called when the
   *  mini panel closes or its branch is cleared. */
  function _wipeMiniOverlays() {
    const Mini = window.MiniChart;
    const chart = Mini && Mini.chart;
    for (const [, id] of _miniArrowIdBy) {
      if (chart) try { chart.removeOverlay(id); } catch (e) {}
    }
    _miniArrowIdBy.clear();
    for (const [, id] of _miniDurationIdBy) {
      if (chart) try { chart.removeOverlay(id); } catch (e) {}
    }
    _miniDurationIdBy.clear();
  }

  function _syncPendingOrders(chart, eng) {
    const orders = eng.getPendingOrders().filter(o => {
      if (!o.active) return false;
      if (o.bracketParentId) return false;     // bracket children: rendered by step-3d band logic
      return o.type !== 'market';
    });
    const want = new Map(orders.map(o => [o.id, o]));

    // Remove overlays for orders no longer pending.
    for (const [orderId, chartId] of _pendingIdBy.entries()) {
      if (!want.has(orderId)) {
        try { chart.removeOverlay(chartId); } catch (e) { /* ignore */ }
        _pendingIdBy.delete(orderId);
        _orderPreviewPrice.delete(orderId);   // drop any stale drag preview
      }
    }

    for (const o of orders) {
      // During an edit-drag the panel writes a preview price here so
      // the canvas line follows the dragged ticket immediately. Falls
      // back to the engine's actual order price when no preview is set.
      const preview = _orderPreviewPrice.get(o.id);
      const priceY = Number.isFinite(preview) ? preview : _orderPriceForLine(o);
      if (!Number.isFinite(priceY)) continue;
      // Anchor X to the placement bar; fall back to the latest bar if
      // the placement bar isn't in view.
      const anchorTs = (o.createdAtBarTs != null)
        ? o.createdAtBarTs
        : (_latestBar() ? _latestBar().timestamp : null);
      if (!Number.isFinite(anchorTs)) continue;

      const ext = {
        side: o.side, type: o.type, qty: o.qty,
        priceLabel: priceY.toFixed(2),
      };
      const existing = _pendingIdBy.get(o.id);
      if (existing) {
        try {
          chart.overrideOverlay({
            id: existing,
            points: [{ timestamp: anchorTs, value: priceY }],
            extendData: ext,
          });
        } catch (e) { /* ignore */ }
      } else {
        try {
          const newId = chart.createOverlay({
            name: 'sim_pending_order',
            points: [{ timestamp: anchorTs, value: priceY }],
            extendData: ext,
          });
          if (newId) _pendingIdBy.set(o.id, newId);
        } catch (e) { /* ignore */ }
      }
    }
  }

  function _syncTradeArrows(chart, eng, opts) {
    // Arrows we'd LIKE to have on screen, keyed by `${posId}.${event}`.
    //   - Every position (open or closed) has an entry arrow.
    //   - Closed positions also have one exit arrow per closed-leg.
    //     For step 3 we only mark the FIRST exit (full close) — partial
    //     fills aren't a documented feature yet.
    //
    // branching-replay-spec §2.1 visibility filter:
    //   - Trade visible to viewing branch iff its branchId is in that
    //     branch's ancestor chain AND it was opened at-or-before the
    //     chain's cutoff (running min of forkBarTimestamps from
    //     viewing down to that ancestor).
    //   - Inherited trades (branchId !== viewingBranchId but in chain)
    //     get `inherited: true` in extendData → faded alpha render.
    //   - Trades on sibling branches (different timeline) are skipped
    //     entirely.
    //
    // Replay cursor filter:
    //   - When replay is active, an arrow's event must have happened
    //     ≤ Replay.cursorTimestamp. Trades that occurred after stepBack
    //     would have happened "in the future" from the user's POV, so
    //     hide them until the cursor advances past again.
    //
    // opts.branchId — which branch the chart is "viewing"; defaults to
    //   BranchEngine.activeBranchId for back-compat (main-chart path).
    // opts.idBy     — overlay-id Map; defaults to module-level
    //   `_arrowIdBy` (main-chart path). Mini chart passes its own
    //   `_miniArrowIdBy` so the two charts' arrows don't collide.
    const want = new Map();
    const idBy = (opts && opts.idBy) || _arrowIdBy;

    // Pre-compute branch + cursor filters once per sync.
    const Engine = window.BranchEngine;
    const viewingBranchId = (opts && opts.branchId)
      || (Engine ? Engine.activeBranchId : 'main');
    const cutoffs = (Engine && Engine.getVisibleTradeCutoffs)
      ? Engine.getVisibleTradeCutoffs(viewingBranchId)
      : new Map([[viewingBranchId, Infinity]]);
    const Replay = window.Replay;
    const cursorTs = (Replay && Replay.active && Number.isFinite(Replay.cursorTimestamp))
      ? Replay.cursorTimestamp : null;

    const allPositions = eng.getPositions().concat(eng.getPositionHistory());
    for (const pos of allPositions) {
      // Branch filter — pos.branchId must be in the active branch's
      // ancestor chain. Defaults to 'main' for legacy positions saved
      // before Phase 1's branchId stamping shipped.
      const posBranchId = pos.branchId || 'main';
      const cutoff = cutoffs.has(posBranchId) ? cutoffs.get(posBranchId) : null;
      if (cutoff == null) continue;            // sibling timeline → invisible
      if (Number.isFinite(pos.openedAtBarTs) && pos.openedAtBarTs > cutoff) continue;
      const inherited = posBranchId !== viewingBranchId;

      const entryOrder = pos.entryOrderIds && pos.entryOrderIds.length
        ? eng.getOrder(pos.entryOrderIds[0])
        : null;
      if (entryOrder && Number.isFinite(entryOrder.filledAtBarTs)) {
        // Replay cursor: skip arrows whose event is past the cursor.
        const inFuture = (cursorTs != null) && (entryOrder.filledAtBarTs > cursorTs);
        if (!inFuture) {
          const bar = _findBarByTimestamp(entryOrder.filledAtBarTs);
          if (bar) {
            const isUp = pos.side === 'long';   // long entry → up arrow at bar.low
            want.set(`${pos.id}.entry`, {
              ts: bar.timestamp,
              value: isUp ? bar.low : bar.high,
              isUp,
              posId: pos.id,
              event: 'entry',
              ext: { side: pos.side, event: 'entry', inherited, stackIndex: 0 },
            });
          }
        }
      }
      // Exit arrow (closed positions only).
      if (pos.closedAtBarTs != null && pos.exitOrderIds && pos.exitOrderIds.length) {
        // Branch filter — exit also has to be at-or-before the cutoff.
        // If the position closed AFTER active's fork cutoff, it closed
        // in a different timeline — show only the inherited entry, not
        // the exit (which "didn't happen" in active's timeline).
        const exitOrder = eng.getOrder(pos.exitOrderIds[pos.exitOrderIds.length - 1]);
        if (exitOrder && Number.isFinite(exitOrder.filledAtBarTs)) {
          const exitInFork = !Number.isFinite(pos.closedAtBarTs) || pos.closedAtBarTs <= cutoff;
          const exitInPast = (cursorTs == null) || (exitOrder.filledAtBarTs <= cursorTs);
          if (exitInFork && exitInPast) {
            const bar = _findBarByTimestamp(exitOrder.filledAtBarTs);
            if (bar) {
              // Long exit → red ↓ above high; short exit → blue ↑ below low.
              const isUp = pos.side === 'short';
              want.set(`${pos.id}.exit`, {
                ts: bar.timestamp,
                value: isUp ? bar.low : bar.high,
                isUp,
                posId: pos.id,
                event: 'exit',
                ext: { side: pos.side, event: 'exit', inherited, stackIndex: 0 },
              });
            }
          }
        }
      }
    }

    // Same-bar same-direction stacking. Close-and-reverse produces a
    // long-exit ↓ + short-entry ↓ on the same K-bar at the same
    // bar.high anchor — without offset they overlap and the user
    // can't tell two events happened. Group by (timestamp, direction),
    // sort within group so older events sit closer to the wick, and
    // assign stackIndex 0 / 1 / 2 ... per arrow.
    //
    // Order rule: within a same-direction same-bar group, sort by
    //   (posId asc, event 'exit' before 'entry').
    // Because the close-and-reverse uses ONE order id producing
    // pos_old.exit and pos_new.entry where pos_new.id > pos_old.id,
    // the exit lands at stackIndex 0 (closest to wick) and the new
    // entry at stackIndex 1 — matches the user's spec
    // ("空單進場箭頭放在多單出場箭頭的上面").
    const groups = new Map();
    for (const [key, info] of want.entries()) {
      const gk = `${info.ts}.${info.isUp ? 'up' : 'down'}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push({ key, info });
    }
    for (const arr of groups.values()) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => {
        if (a.info.posId !== b.info.posId) return a.info.posId - b.info.posId;
        const evRank = (e) => (e === 'exit' ? 0 : 1);
        return evRank(a.info.event) - evRank(b.info.event);
      });
      arr.forEach((entry, idx) => { entry.info.ext.stackIndex = idx; });
    }

    // Remove arrows that no longer have a backing event.
    for (const [key, chartId] of idBy.entries()) {
      if (!want.has(key)) {
        try { chart.removeOverlay(chartId); } catch (e) { /* ignore */ }
        idBy.delete(key);
      }
    }
    // Add missing arrows AND update existing ones — the entry bar may
    // still be in-progress (the user filled on a placeholder cursor or
    // mid-bar partial), so its low/high can shift each tick. We re-pin
    // the arrow's anchor on every sync so it tracks the wick instead
    // of staying at the snapshot value taken at fill time.
    for (const [key, info] of want.entries()) {
      const existing = idBy.get(key);
      if (existing) {
        try {
          chart.overrideOverlay({
            id: existing,
            points: [{ timestamp: info.ts, value: info.value }],
            extendData: info.ext,
          });
        } catch (e) { /* ignore */ }
      } else {
        try {
          const newId = chart.createOverlay({
            name: 'sim_trade_arrow',
            points: [{ timestamp: info.ts, value: info.value }],
            extendData: info.ext,
          });
          if (newId) idBy.set(key, newId);
        } catch (e) { /* ignore */ }
      }
    }
  }

  function _syncPositionDuration(chart, eng, opts) {
    // One vertical-duration line per OPEN position. Closed positions
    // could keep their span too (frozen between entry and exit), but
    // the spec doesn't ask for it and the chart stays cleaner without.
    //
    // Branch filter (opts.branchId): only show duration lines for
    //   positions whose branchId is in the viewing branch's ancestor
    //   chain. Sibling-timeline open positions are hidden — same
    //   §2.1 rule used for trade arrows. Defaults to active for the
    //   main-chart path. opts.idBy lets the mini chart use its own
    //   overlay-id Map so the two charts don't clobber each other.
    const idBy = (opts && opts.idBy) || _durationIdBy;
    const Engine = window.BranchEngine;
    const viewingBranchId = (opts && opts.branchId)
      || (Engine ? Engine.activeBranchId : 'main');
    const cutoffs = (Engine && Engine.getVisibleTradeCutoffs)
      ? Engine.getVisibleTradeCutoffs(viewingBranchId)
      : new Map([[viewingBranchId, Infinity]]);

    const positions = eng.getPositions().filter((p) => {
      const bid = p.branchId || 'main';
      const cutoff = cutoffs.has(bid) ? cutoffs.get(bid) : null;
      if (cutoff == null) return false;
      return !(Number.isFinite(p.openedAtBarTs) && p.openedAtBarTs > cutoff);
    });
    const latest = _latestBar();

    // Remove duration lines for closed / out-of-branch positions.
    const visibleIds = new Set(positions.map(p => p.id));
    for (const [posId, chartId] of idBy.entries()) {
      if (!visibleIds.has(posId)) {
        try { chart.removeOverlay(chartId); } catch (e) { /* ignore */ }
        idBy.delete(posId);
      }
    }

    if (!latest) return;
    for (const pos of positions) {
      const ext = { side: pos.side };
      // Two anchor points share an arbitrary timestamp (the latest bar's)
      // since the renderer ignores X and pins to bounding.width. The Y
      // values are what matter: entry price + current price.
      const points = [
        { timestamp: latest.timestamp, value: pos.avgEntryPrice },
        { timestamp: latest.timestamp, value: latest.close },
      ];
      const existing = idBy.get(pos.id);
      if (existing) {
        try {
          chart.overrideOverlay({ id: existing, points, extendData: ext });
        } catch (e) { /* ignore */ }
      } else {
        try {
          const newId = chart.createOverlay({
            name: 'sim_position_duration', points, extendData: ext,
          });
          if (newId) idBy.set(pos.id, newId);
        } catch (e) { /* ignore */ }
      }
    }
  }

  function _syncBrackets(chart, eng) {
    // For each open position, draw 0–2 bracket bands (TP and / or SL).
    // The exit price comes from one of two sources:
    //
    //   - Proposal phase (Panel.proposalState.active for this position):
    //       price = proposalState.tp / .sl, dragging = (draggingLeg matches)
    //   - Committed phase (engine has bracket children):
    //       price = child.price (TP) / child.stopPrice (SL), dragging = false
    //
    // 捨棄'd positions stay in committed phase with no children → no
    // band, just the naked position line. Each band is a 1-point
    // overlay (point at the EXIT price); the entry side is rendered
    // from extendData via yAxis.convertToPixel inside createPointFigures.
    const ps = (window.SimPanel && window.SimPanel.proposalState) || null;
    const want = new Map();
    const spec = (window.SimController && window.SimController.spec) || {};
    const pv  = spec.pointValue || 1;
    const lot = spec.lotSize    || 1;
    // Anchor X for the band overlay's draggable point. We use the
    // latest bar's timestamp so the handle sits near the chart's
    // right edge (where the user expects to grab the TP/SL line in
    // a TradingView-style flow).
    const latest = (window.SimController && window.SimController.getLatestBar)
      ? window.SimController.getLatestBar() : null;
    const anchorTs = latest ? latest.timestamp : null;

    // ----- Entry lines -------------------------------------------------
    // One per open position. Sync first so it sits BENEATH the bracket
    // bands in the overlay z-order (KLineChart renders overlays in
    // creation order; later overlays paint on top).
    const wantEntry = new Map();   // positionId → { ts, value, side }
    for (const pos of eng.getPositions()) {
      const eo = (pos.entryOrderIds && pos.entryOrderIds.length)
        ? eng.getOrder(pos.entryOrderIds[0]) : null;
      if (!eo || !Number.isFinite(eo.filledAtBarTs)) continue;
      wantEntry.set(pos.id, {
        ts: eo.filledAtBarTs,
        value: pos.avgEntryPrice,
        side: pos.side,
      });
    }
    for (const [posId, chartId] of _entryLineIdBy.entries()) {
      if (!wantEntry.has(posId)) {
        try { chart.removeOverlay(chartId); } catch (e) { /* ignore */ }
        _entryLineIdBy.delete(posId);
      }
    }
    for (const [posId, info] of wantEntry.entries()) {
      const points = [{ timestamp: info.ts, value: info.value }];
      const ext = { side: info.side };
      const existing = _entryLineIdBy.get(posId);
      if (existing) {
        try { chart.overrideOverlay({ id: existing, points, extendData: ext }); }
        catch (e) { /* ignore */ }
      } else {
        try {
          const newId = chart.createOverlay({
            name: 'sim_entry_line', points, extendData: ext,
          });
          if (newId) _entryLineIdBy.set(posId, newId);
        } catch (e) { /* ignore */ }
      }
    }

    for (const pos of eng.getPositions()) {
      const entryOrder = (pos.entryOrderIds && pos.entryOrderIds.length)
        ? eng.getOrder(pos.entryOrderIds[0]) : null;
      if (!entryOrder || !Number.isFinite(entryOrder.filledAtBarTs)) continue;
      const entryTs = entryOrder.filledAtBarTs;
      const inProposal = ps && ps.active && ps.positionId === pos.id;
      const dir = pos.side === 'long' ? 1 : -1;
      const fmtUSD = (n) => (n >= 0 ? '+' : '') + Math.round(n).toLocaleString('en-US') + ' USD';

      // bracket-ux-polish §1 + §4: phase + per-leg invalid flags get
      // stamped onto extendData so the figure builder can render the
      // matching state (line dashed/solid, band 0/10/32% fill, warning
      // ring + ⚠ glyph). Outside of an active proposal the band is in
      // committed/naked state — phase 'armed' fits that case (no buttons,
      // solid line, no fill).
      const phase = inProposal ? (ps.phase || 'pending') : 'armed';
      const validity = (inProposal && ps.validity) || {};

      // -------- TP --------
      let tpPrice = null;
      if (inProposal && Number.isFinite(ps.tp)) {
        tpPrice = ps.tp;
      } else if (!inProposal) {
        const child = eng.getPendingOrders().find(
          o => o.bracketParentId === entryOrder.id && o.type === 'limit');
        if (child) tpPrice = child.price;
      }
      if (Number.isFinite(tpPrice)) {
        const usd = (tpPrice - pos.avgEntryPrice) * dir * pos.qty * pv * lot;
        const dragging = !!(ps && ps.draggingLeg === 'tp' && inProposal);
        want.set(`${pos.id}.tp`, {
          template: 'sim_bracket_band_tp',
          exitPrice: tpPrice,
          ext: {
            leg: 'tp',
            dragging,
            phase,
            invalid: validity.tp === 'invalid',
            usdLabel: fmtUSD(usd),
            qty: pos.qty,
            entryPrice: pos.avgEntryPrice,
            entryTs,
            anchorTs,
          },
        });
      }

      // -------- SL --------
      let slPrice = null;
      if (inProposal && Number.isFinite(ps.sl)) {
        slPrice = ps.sl;
      } else if (!inProposal) {
        const child = eng.getPendingOrders().find(
          o => o.bracketParentId === entryOrder.id && o.type === 'stop');
        if (child) slPrice = child.stopPrice;
      }
      if (Number.isFinite(slPrice)) {
        const usd = (slPrice - pos.avgEntryPrice) * dir * pos.qty * pv * lot;
        const dragging = !!(ps && ps.draggingLeg === 'sl' && inProposal);
        want.set(`${pos.id}.sl`, {
          template: 'sim_bracket_band_sl',
          exitPrice: slPrice,
          ext: {
            leg: 'sl',
            dragging,
            phase,
            invalid: validity.sl === 'invalid',
            usdLabel: fmtUSD(usd),
            qty: pos.qty,
            entryPrice: pos.avgEntryPrice,
            entryTs,
            anchorTs,
          },
        });
      }
    }

    // Drop bands no longer wanted.
    for (const [key, chartId] of _bandIdBy.entries()) {
      if (!want.has(key)) {
        try { chart.removeOverlay(chartId); } catch (e) { /* ignore */ }
        _bandIdBy.delete(key);
      }
    }
    // Add / update kept ones. Single point at (anchorTs, exitPrice) —
    // this is what KLineChart will render the draggable handle on.
    // Template name is leg-specific so the handle's circle gets the
    // matching green / red color via styles.point.
    for (const [key, info] of want.entries()) {
      const ts = Number.isFinite(info.ext.anchorTs)
        ? info.ext.anchorTs
        : info.ext.entryTs;
      const points = [{ timestamp: ts, value: info.exitPrice }];
      const existing = _bandIdBy.get(key);
      if (existing) {
        try { chart.overrideOverlay({ id: existing, points, extendData: info.ext }); }
        catch (e) { /* ignore */ }
      } else {
        try {
          const newId = chart.createOverlay({
            name: info.template, points, extendData: info.ext,
          });
          if (newId) _bandIdBy.set(key, newId);
        } catch (e) { /* ignore */ }
      }
    }
  }

  function clearAll() {
    const chart = _chart();
    const drop = (map) => {
      if (chart) {
        for (const id of map.values()) {
          try { chart.removeOverlay(id); } catch (e) { /* ignore */ }
        }
      }
      map.clear();
    };
    drop(_pendingIdBy);
    drop(_arrowIdBy);
    drop(_durationIdBy);
    drop(_bandIdBy);
    drop(_entryLineIdBy);
  }

  /** Set / clear the preview price for an order. Called by sim_panel
   *  during edit-drag so the dashed line moves with the dragged ticket
   *  before 確認 commits via engine.modifyOrder. Pass `null` to clear
   *  the preview (commit / discard) — line snaps back to engine value
   *  on the next sync. */
  function previewOrderPrice(orderId, price) {
    if (price == null || !Number.isFinite(price)) {
      _orderPreviewPrice.delete(orderId);
    } else {
      _orderPreviewPrice.set(orderId, price);
    }
    sync();
  }

  window.SimOverlays = { sync, clearAll, previewOrderPrice, _registerTemplates };
})();
