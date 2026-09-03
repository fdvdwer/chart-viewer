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
  // Mini-chart bracket bands + entry lines. Read-only (lock:true on
  // create) so the sub-chart shows the branch's position box (entry /
  // TP / SL) without the draggable handles the main chart's bands have.
  const _miniBandIdBy      = new Map();
  const _miniEntryLineIdBy = new Map();
  const _miniBeLineIdBy    = new Map();
  // Bracket bands: keyed by `${positionId}.tp` / `${positionId}.sl` so
  // the TP and SL legs of a position are tracked independently and can
  // be added / removed individually.
  const _bandIdBy     = new Map();
  // Entry line: one full-width horizontal dashed line per open position,
  // sitting at the entry price. Renders in BLUE (#2962ff) to pair with
  // the entry ticket DOM in #sim-bracket-tickets. Keyed by positionId.
  const _entryLineIdBy = new Map();
  // Adjusted break-even line (sim-multi-tp-feature "risk-free runner"):
  // one full-width dashed PURPLE line per open position, drawn ONLY once
  // the position has banked realised P/L from a partial exit (otherwise
  // it coincides with the entry line and is hidden). Sits at
  //   avgEntry − realisedPnL / (qty · dir · pv · lot)
  // i.e. the price at which the runner giving back exactly the banked
  // gains nets the whole trade to zero. Keyed by positionId.
  const _beLineIdBy = new Map();
  // Entry↔exit connector line (MultiCharts-style, opt-in via
  // SimPanel.showTradeLink()): a flat dashed segment at the entry price,
  // spanning from the entry bar to the exit bar (closed) or to that
  // chart's own latest bar (still open). Fixed by SIDE, not P/L — green
  // for long, red for short. Drawn for BOTH open and closed positions
  // (position history), unlike sim_entry_line which is open-only and
  // full-width. Keyed by positionId; main-chart only maps to _tradeLinkIdBy,
  // per-pane maps live alongside the pane's other overlay-id maps.
  const _tradeLinkIdBy = new Map();

  // Multi-timeframe panes (pane_manager.js): unlike the single fixed
  // mini chart, panes are dynamic (added/removed/TF-switched at
  // runtime) — one full set of overlay-id maps per pane, created lazily
  // via _getPaneMaps() and dropped via dropPaneMaps() when a pane is
  // disposed. Panes get the FULL draggable set (readOnly:false) since
  // it's the same underlying position everywhere, not a branch mirror —
  // see _syncBrackets's opts.readOnly.
  const _paneOverlayMaps = new Map(); // paneId → {bandIdBy, entryLineIdBy, beLineIdBy, arrowIdBy, durationIdBy}
  function _getPaneMaps(paneId) {
    let m = _paneOverlayMaps.get(paneId);
    if (!m) {
      m = {
        bandIdBy: new Map(), entryLineIdBy: new Map(), beLineIdBy: new Map(),
        arrowIdBy: new Map(), durationIdBy: new Map(), tradeLinkIdBy: new Map(),
      };
      _paneOverlayMaps.set(paneId, m);
    }
    return m;
  }
  /** Drop one pane's overlay-id maps without touching its chart — call
   *  AFTER the pane's chart instance is already disposed (pane_manager.js
   *  _disposePane/_disposeAllCharts), since chart.removeOverlay on an
   *  already-torn-down instance would just throw into the try/catch for
   *  nothing. Safe to call for a paneId with no maps (no-op). */
  function dropPaneMaps(paneId) {
    _paneOverlayMaps.delete(paneId);
  }

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
        const ext = (overlay && overlay.extendData) || {};
        const side = ext.side || 'long';
        const color = side === 'short' ? '#ef5350' : '#2962ff';
        const figs = [{
          type: 'line',
          attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
          styles: { color, size: 1, style: 'dashed', dashedValue: [2, 4] },
        }];
        // showLabels-gated R/R chip (multi-timeframe panes only — see
        // _syncBrackets's opts.showLabels doc comment). Sits at the left
        // edge like sim_be_line's own label, one row above so the two
        // don't overlap when both are present.
        if (ext.rrLabel) {
          figs.push({
            type: 'text',
            attrs: { x: 6, y: y - 14, text: ext.rrLabel, align: 'left', baseline: 'bottom' },
            styles: {
              color: '#ffffff', size: 10,
              family: 'system-ui,-apple-system,sans-serif',
              backgroundColor: `rgba(${side === 'short' ? '239,83,80' : '41,98,255'}, 0.85)`,
              borderColor: 'transparent', borderSize: 0,
              paddingLeft: 4, paddingRight: 4, paddingTop: 1, paddingBottom: 1,
            },
          });
        }
        return figs;
      },
    });

    // ----- Adjusted break-even line -----
    //
    // Horizontal dashed PURPLE line at the "risk-free runner" break-even
    // (avgEntry adjusted for banked realised P/L). Distinct from the blue
    // entry line so the user can read both at once. A short label sits at
    // the left edge over a translucent chip; the text is precomputed in
    // _syncBrackets (extendData.label) so this builder stays i18n-free.
    // One per open position, only present when realised P/L has moved the
    // BE off the entry (see _syncBrackets).
    klinecharts.registerOverlay({
      name: 'sim_be_line',
      totalStep: 2,
      lock: true,
      needDefaultPointFigure: false,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: false,
      createPointFigures: ({ coordinates, overlay, bounding }) => {
        if (!coordinates || coordinates.length < 1 || !bounding) return [];
        const y = coordinates[0].y;
        const ext = (overlay && overlay.extendData) || {};
        const color = '#9575cd';
        const figs = [{
          type: 'line',
          attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
          styles: { color, size: 1, style: 'dashed', dashedValue: [6, 4] },
        }];
        if (ext.label) {
          figs.push({
            type: 'text',
            attrs: { x: 6, y: y - 2, text: ext.label, align: 'left', baseline: 'bottom' },
            styles: {
              color: '#ffffff', size: 10,
              family: 'system-ui,-apple-system,sans-serif',
              backgroundColor: 'rgba(149,117,205,0.85)',
              borderColor: 'transparent', borderSize: 0,
              paddingLeft: 4, paddingRight: 4, paddingTop: 1, paddingBottom: 1,
            },
          });
        }
        return figs;
      },
    });

    // ----- Entry↔exit connector line (opt-in, MultiCharts-style) -----
    //
    // Two-point overlay: {entryTs, entryPrice} → {endTs, exitPrice} — a
    // DIAGONAL dashed line, the actual price path from entry to exit (NOT
    // flat at the entry price — corrected per the user's MultiCharts
    // reference: the line has real slope, and each endpoint gets its own
    // small side-pointing "flag" triangle marking exactly where it meets
    // that price, tip touching the point). endTs/exitPrice is the exit
    // bar+price for a closed position, or that chart's own latest bar +
    // current close while still open (keeps sloping live). Both bar
    // timestamps are pre-resolved by _syncTradeLinks via the same
    // _findBarByTimestamp call the trade arrows use, so the line's ends
    // land on the exact bar the corresponding arrow sits on. Color is
    // ext.color, a hex string _syncTradeLinks resolves from
    // SimPanel.tradeLinkColor() (user-adjustable win/loss colors —
    // position-tool-settings pickers).
    klinecharts.registerOverlay({
      name: 'sim_trade_link',
      totalStep: 2,
      lock: true,
      needDefaultPointFigure: false,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: false,
      createPointFigures: ({ coordinates, overlay }) => {
        if (!coordinates || coordinates.length < 2) return [];
        const ext = (overlay && overlay.extendData) || {};
        const color = ext.color || '#26a69a';
        const figs = [{
          type: 'line',
          attrs: { coordinates: [coordinates[0], coordinates[1]] },
          styles: { color, size: 1, style: 'dashed', dashedValue: [2, 3] },
        }];
        // Side-pointing "flag" triangle at each endpoint — tip touches
        // the exact (bar, price) point, body trails back toward the
        // other end so it reads as an arrowhead the dashed line runs
        // into. Fixed small size regardless of zoom (matches how the
        // trade-arrow triangles are drawn — see sim_trade_arrow above).
        const TRI_LEN = 6, TRI_HALF_H = 5;
        for (let i = 0; i < 2; i++) {
          const tip = coordinates[i];
          const other = coordinates[1 - i];
          const dir = other.x >= tip.x ? 1 : -1;   // trail toward the other point
          const baseX = tip.x + dir * TRI_LEN;
          figs.push({
            type: 'polygon',
            attrs: { coordinates: [
              { x: tip.x, y: tip.y },
              { x: baseX, y: tip.y - TRI_HALF_H },
              { x: baseX, y: tip.y + TRI_HALF_H },
            ] },
            styles: { style: 'fill', color },
          });
        }
        return figs;
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
    _registerBracketTemplate('sim_bracket_band_tp', '#089981', false);
    _registerBracketTemplate('sim_bracket_band_sl', '#ff9800', false);
    // Draggable variants for COMMITTED legs on the main chart: a proper
    // finished (totalStep:1) overlay with a default point handle so the
    // user can grab the line and drag it to re-price (onPressedMoveEnd →
    // modifyOrder). The plain variants above stay locked/handle-less for
    // the DOM-ticket-driven proposal leg and the read-only mini.
    _registerBracketTemplate('sim_bracket_band_tp_drag', '#089981', true);
    _registerBracketTemplate('sim_bracket_band_sl_drag', '#ff9800', true);

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
  function _registerBracketTemplate(name, accentColor, draggable) {
    if (typeof klinecharts === 'undefined' || !klinecharts.registerOverlay) return;
    const spec = {
      name,
      // draggable → totalStep:1 (a finished, single-point overlay whose
      // point is a draggable anchor). Non-draggable proposal/mini legs keep
      // totalStep:2 + no handle; their drag is the DOM ticket.
      totalStep: draggable ? 1 : 2,
      lock: !draggable,
      needDefaultPointFigure: !!draggable,   // hover shows the grab handle
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: false,
      createPointFigures: (params) => _buildBracketFigures(params, accentColor),
    };
    if (draggable) {
      // Anchor handle (appears on hover at the point = right edge / exit
      // price). Grab it to drag the line; onPressedMoveEnd re-prices.
      spec.styles = { point: {
        color: accentColor, borderColor: '#ffffff', borderSize: 1,
        radius: 5, activeRadius: 6,
      } };
      spec.onPressedMoveEnd = (event) => _onBracketDragEnd(event);
    }
    klinecharts.registerOverlay(spec);
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
      // Progressive display (user spec): the ACTIVE leg (nearest unfilled
      // TP, or an SL) is a full-opacity 2px line; a dimmed later TP is a
      // translucent 1px line. When the active TP fills its band drops and
      // the next TP loses its `dim` flag → brightens on the next sync.
      const dim = !!ext.dim;
      figures.push({
        type: 'line',
        attrs: { coordinates: [{ x: 0, y: exitY }, { x: rightX, y: exitY }] },
        // Active leg → solid 2px full-opacity. A queued later TP → faint
        // 1px dashed so it reads as "not your turn yet"; it turns solid +
        // bright automatically once it becomes the nearest unfilled TP.
        styles: dim
          ? { color: `rgba(${rgb}, 0.45)`, size: 1, style: 'dashed', dashedValue: [4, 4] }
          : { color: strokeColor, size: 2, style: 'solid' },
      });
    } else {
      figures.push({
        type: 'line',
        attrs: { coordinates: [{ x: 0, y: exitY }, { x: rightX, y: exitY }] },
        styles: { color: strokeColor, size: 1, style: 'dashed', dashedValue: [2, 4] },
      });
    }
    // showLabels-gated USD P/L chip (multi-timeframe panes only — see
    // _syncBrackets's opts.showLabels doc comment; main/mini already
    // show this via the DOM ticket rail / don't need it). Anchored just
    // left of the draggable handle (coordinates[0].x, near the pane's
    // right edge) so it sits next to whatever the user is about to grab
    // instead of overlapping the R/R chip pinned at the left edge.
    if (ext.showLabel && ext.usdLabel) {
      const anchorX = coordinates[0].x;
      figures.push({
        type: 'text',
        attrs: { x: Math.max(4, anchorX - 10), y: exitY - 2, text: ext.usdLabel, align: 'right', baseline: 'bottom' },
        styles: {
          color: '#ffffff', size: 10,
          family: 'system-ui,-apple-system,sans-serif',
          backgroundColor: `rgba(${rgb}, 0.85)`,
          borderColor: 'transparent', borderSize: 0,
          paddingLeft: 4, paddingRight: 4, paddingTop: 1, paddingBottom: 1,
        },
      });
    }
    return figures;
  }

  /** Commit a committed-leg drag: read the dragged price off the overlay
   *  point, snap to tick, and re-price the engine order. The in-proposal
   *  draft leg has no childOrderId and is locked, so this never fires for
   *  it. Dragging opts the bracket into the reduce-only group (OCO
   *  stripped) exactly like editing a row in the panel list. */
  function _onBracketDragEnd(event) {
    const ov  = event && event.overlay;
    const ext = ov && ov.extendData;
    if (!ov || !ext || ext.childOrderId == null) return false;
    const pt = ov.points && ov.points[0];
    if (!pt || !Number.isFinite(pt.value)) return false;
    const Ctrl  = window.SimController;
    const Panel = window.SimPanel;
    const eng   = Ctrl && Ctrl.engine;
    if (!eng) return false;
    const order = eng.getOrder(ext.childOrderId);
    if (!order) return false;
    const tick = (Ctrl.spec && Ctrl.spec.tickSize) || 0.01;
    const price = +(Math.round(pt.value / tick) * tick).toFixed(10);
    if (Panel && Panel._stripBracketOco && order.bracketParentId != null) {
      Panel._stripBracketOco(order.bracketParentId);
    }
    eng.modifyOrder(order.id,
      order.type === 'limit' ? { price } : { stopPrice: price });
    if (Ctrl._tickNow)   Ctrl._tickNow();
    if (Ctrl._markDirty) Ctrl._markDirty();
    if (Panel && Panel.refresh) { try { Panel.refresh(); } catch (e) {} }
    sync();
    return false;
  }

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
   *  Uses a FLOOR lookup (last bar with timestamp <= ts), not exact
   *  equality: a fill's timestamp is stamped at whatever TF was active
   *  at fill time (e.g. a 1-min boundary like 10:07:00). If the chart is
   *  later switched to a coarser TF (e.g. 15-min bars at 10:00/10:15/...),
   *  no bar shares that exact timestamp — exact-match lookup would return
   *  null and the marker would silently vanish from `sync()`'s `want` map.
   *  Floor lookup instead finds the coarser bar that CONTAINS the fill
   *  timestamp, mirroring the binary search in replay.js's
   *  findDisplayBarStart().
   *
   *  We accept placeholder bars too: if the user filled a market order
   *  on the very first cursor pick (before any tick), the bar at the
   *  fill timestamp is a placeholder with all OHLC = placeholderFillPrice.
   *  Returning it lets the arrow draw at that price level immediately;
   *  on the next tick the bar materialises into a real K-bar and
   *  _syncTradeArrows re-positions the arrow under the new wick.
   *
   *  `barsOverride`, when given, is searched INSTEAD of the main chart's
   *  own bars. A multi-timeframe pane (pane_manager.js) needs this: its
   *  own bar series can be a much finer TF than main's, and the fill's
   *  exact low/high only exists on the bar that actually contains it.
   *  Resolving every pane's arrow against main's (coarser) bars would
   *  floor-lookup to main's bar covering the fill, then plant the arrow
   *  at THAT bar's aggregate low/high — visually close on a slightly
   *  finer pane, but badly off on a much finer one (e.g. main=15m,
   *  pane=1m: the 15-minute low/high can sit many 1-minute bars away
   *  from where the fill itself happened), and the X position also
   *  snaps to main's coarser bar boundary instead of the pane's own bar
   *  — exactly the "1 分鐘顆粒對不上，5/15 分鐘還好" symptom reported. */
  function _findBarByTimestamp(ts, barsOverride) {
    if (!Number.isFinite(ts)) return null;
    let bars;
    if (Array.isArray(barsOverride)) {
      bars = barsOverride;
    } else {
      const R = window.Replay;
      bars = (window.App && window.App.currentBars) || [];
      if (R && R.active && R.displayBars && R.displayBars.length) {
        bars = R.displayBars;
      }
    }
    if (!bars.length) return null;
    let lo = 0, hi = bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].timestamp > ts) hi = mid - 1;
      else lo = mid + 1;
    }
    if (hi < 0) return null;
    const b = bars[hi];
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
      _syncTradeLinks(main, eng);
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
      // Position box (entry line + TP/SL bands) for the mini's branch.
      // read-only so the sub-chart mirrors the box without draggable
      // handles; own id-maps so it doesn't clobber the main chart's.
      _syncBrackets(Mini.chart, eng, {
        branchId: miniBranchId,
        idBy: _miniBandIdBy,
        entryIdBy: _miniEntryLineIdBy,
        beIdBy: _miniBeLineIdBy,
        readOnly: true,
      });
    } else {
      // Mini closed or no branch set — wipe any stale overlays from
      // the mini chart's overlay-id maps so the next open re-creates
      // them cleanly. KLineChart removeOverlay on a chart that no
      // longer has the overlay is a no-op.
      _wipeMiniOverlays();
    }

    // Multi-timeframe panes (pane_manager.js) — same position, full
    // draggable set on EVERY active pane (not a branch mirror like mini,
    // so no branchId filter — defaults to BranchEngine.activeBranchId,
    // same as main). Each pane's overlays are anchored to THAT pane's
    // own latest bar, not main's — panes run their own (possibly
    // different-TF, possibly replay-lagged per Phase 3's design) bar
    // series, and anchoring to a timestamp outside a pane's own data
    // range would misplace or fail to attach the draggable handle.
    const PM = window.PaneManager;
    if (PM && Array.isArray(PM.panes)) {
      for (const pane of PM.panes) {
        if (!pane.chart) continue;
        const dataList = pane.chart.getDataList ? pane.chart.getDataList() : [];
        let paneLatest = null;
        for (let i = dataList.length - 1; i >= 0; i--) {
          if (!dataList[i]._placeholder) { paneLatest = dataList[i]; break; }
        }
        if (!paneLatest) continue; // pane has no real data yet — next sync() retries
        const maps = _getPaneMaps(pane.id);
        // bars: this pane's OWN series, so a fill's arrow anchors to the
        // exact bar (and its real low/high) that pane displays at ITS OWN
        // TF — not main's, which would misplace fine-TF panes. See
        // _findBarByTimestamp's doc comment.
        _syncTradeArrows(pane.chart, eng, { idBy: maps.arrowIdBy, bars: dataList });
        _syncPositionDuration(pane.chart, eng, { idBy: maps.durationIdBy, anchorBar: paneLatest });
        _syncBrackets(pane.chart, eng, {
          idBy: maps.bandIdBy, entryIdBy: maps.entryLineIdBy, beIdBy: maps.beLineIdBy,
          anchorTs: paneLatest.timestamp,
          showLabels: true,
        });
        _syncTradeLinks(pane.chart, eng, { idBy: maps.tradeLinkIdBy, anchorBar: paneLatest, bars: dataList });
      }
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
    for (const [, id] of _miniBandIdBy) {
      if (chart) try { chart.removeOverlay(id); } catch (e) {}
    }
    _miniBandIdBy.clear();
    for (const [, id] of _miniEntryLineIdBy) {
      if (chart) try { chart.removeOverlay(id); } catch (e) {}
    }
    _miniEntryLineIdBy.clear();
    for (const [, id] of _miniBeLineIdBy) {
      if (chart) try { chart.removeOverlay(id); } catch (e) {}
    }
    _miniBeLineIdBy.clear();
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
          const bar = _findBarByTimestamp(entryOrder.filledAtBarTs, opts && opts.bars);
          if (bar) {
            const isUp = pos.side === 'long';   // long entry → up arrow at bar.low
            // Anchor at the resolved bar's OWN wick extreme (chart_viewer's
            // original convention — user call: the triangle marks "this
            // bar, at its edge", not the literal transacted price, which
            // can land mid-candle-body and read as ambiguous). What
            // actually matters for correctness is picking the right BAR —
            // _findBarByTimestamp + filledAtBarTs precision (see
            // sim_engine's _fillOrder / replay.js's onReplayTick call site)
            // — not which value inside that bar the triangle sits at.
            const value = isUp ? bar.low : bar.high;
            want.set(`${pos.id}.entry`, {
              ts: bar.timestamp,
              value,
              isUp,
              posId: pos.id,
              event: 'entry',
              ext: { side: pos.side, event: 'entry', inherited, stackIndex: 0 },
            });
          }
        }
      }
      // Exit arrows — one per FILLED exit order. This now includes PARTIAL
      // reduce-only fills on a still-open position (e.g. TP1 closing 1 of 3
      // lots), so each scale-out drops its own 平倉 triangle at the fill bar;
      // the final close of a closed position is just the last one. (user
      // spec: "TP1 到了 → 出現平倉的三角形".) Each exit is keyed by its own
      // order id so partials don't collide.
      if (pos.exitOrderIds && pos.exitOrderIds.length) {
        for (const exId of pos.exitOrderIds) {
          const exitOrder = eng.getOrder(exId);
          if (!exitOrder || !Number.isFinite(exitOrder.filledAtBarTs)) continue;
          const evTs = exitOrder.filledAtBarTs;
          // Branch + replay-cursor filters, per exit event.
          const exitInFork = evTs <= cutoff;
          const exitInPast = (cursorTs == null) || (evTs <= cursorTs);
          if (!exitInFork || !exitInPast) continue;
          const bar = _findBarByTimestamp(evTs, opts && opts.bars);
          if (!bar) continue;
          // Long exit → red ↓ above high; short exit → blue ↑ below low.
          const isUp = pos.side === 'short';
          // Bar's own wick extreme — see the entry arrow's comment above.
          const value = isUp ? bar.low : bar.high;
          want.set(`${pos.id}.exit.${exId}`, {
            ts: bar.timestamp,
            value,
            isUp,
            posId: pos.id,
            event: 'exit',
            ext: { side: pos.side, event: 'exit', inherited, stackIndex: 0 },
          });
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
    // Defaults to the MAIN chart's latest bar; opts.anchorBar overrides
    // for a multi-timeframe pane — same reasoning as _syncBrackets's
    // opts.anchorTs, PLUS the anchor bar's `close` is actually used as
    // the line's "current price" endpoint value (not just an X
    // position), so a pane should show ITS OWN current price here, not
    // main's, to stay consistent with what that pane's candles show.
    const latest = (opts && opts.anchorBar) || _latestBar();

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

  /** Entry↔exit connector line (opt-in — SimPanel.showTradeLink()).
   *  Draws, for EVERY position (open + history, unlike _syncPositionDuration
   *  which is open-only), a dashed line from (entry bar, entry price) to
   *  (exit bar, exit price) — real slope, not flat — or to opts.anchorBar /
   *  this chart's own latest bar + close while still open (keeps sloping
   *  live). opts mirrors the
   *  other _sync* functions: idBy (per-chart overlay-id map), branchId
   *  (mini-style filter, unused by the main/pane call sites today),
   *  anchorBar (pane's own latest bar, so a still-open position's line
   *  extends to what THAT pane currently shows, not main's), bars (that
   *  chart's own bar list — see the _findBarByTimestamp calls below). */
  function _syncTradeLinks(chart, eng, opts) {
    const Panel = window.SimPanel;
    const idBy = (opts && opts.idBy) || _tradeLinkIdBy;
    if (!Panel || !Panel.showTradeLink || !Panel.showTradeLink()) {
      // Feature off (or panel not ready yet) — sweep any leftover
      // overlays (e.g. user just unchecked it) and bail.
      for (const [, id] of idBy.entries()) {
        try { chart.removeOverlay(id); } catch (e) { /* ignore */ }
      }
      idBy.clear();
      return;
    }
    const filterBranchId = (opts && opts.branchId) || null;
    const latest = (opts && opts.anchorBar) || _latestBar();
    const winColor  = Panel.tradeLinkColor ? Panel.tradeLinkColor('win')  : '#26a69a';
    const lossColor = Panel.tradeLinkColor ? Panel.tradeLinkColor('loss') : '#ef5350';

    const want = new Map();   // positionId → { entryTs, endTs, value, color }
    const allPositions = eng.getPositions().concat(eng.getPositionHistory());
    for (const pos of allPositions) {
      if (filterBranchId && pos.branchId !== filterBranchId) continue;
      const entryOrder = pos.entryOrderIds && pos.entryOrderIds.length
        ? eng.getOrder(pos.entryOrderIds[0]) : null;
      if (!entryOrder || !Number.isFinite(entryOrder.filledAtBarTs)) continue;
      // Resolve to the SAME bar the entry/exit ARROW lands on for THIS
      // chart (_findBarByTimestamp + opts.bars, exactly like
      // _syncTradeArrows) — using the raw order timestamp directly (like
      // sim_entry_line does) let KLineChart pick its own nearest-match,
      // which on a pane can differ by a bar from what the arrow actually
      // sits on, leaving a visible gap between the line's end and the
      // triangle it's supposed to reach.
      const entryBar = _findBarByTimestamp(entryOrder.filledAtBarTs, opts && opts.bars);
      if (!entryBar) continue;

      const stillOpen = !Number.isFinite(pos.closedAtBarTs);
      let endTs, endValue;
      if (stillOpen) {
        // Already a real bar on THIS chart — no _findBarByTimestamp
        // needed. Slopes toward THAT pane's own current close, not
        // main's, matching _syncPositionDuration's same reasoning.
        endTs = latest ? latest.timestamp : null;
        endValue = latest ? latest.close : null;
      } else {
        const exitBar = _findBarByTimestamp(pos.closedAtBarTs, opts && opts.bars);
        endTs = exitBar ? exitBar.timestamp : null;
        // Qty-weighted average across every exit leg (TP1/TP2/SL
        // scale-outs) — same convention sim_history.js's _exitLegsInfo
        // uses for its own weighted exit price.
        let wp = 0, wq = 0;
        for (const exId of (pos.exitOrderIds || [])) {
          const eo = eng.getOrder(exId);
          if (eo && Number.isFinite(eo.fillPrice) && Number.isFinite(eo.qty)) {
            wp += eo.fillPrice * eo.qty; wq += eo.qty;
          }
        }
        endValue = wq > 0 ? wp / wq : pos.avgEntryPrice;
      }
      if (!Number.isFinite(endTs) || !Number.isFinite(endValue) || endTs < entryBar.timestamp) continue;

      // Win/loss color (user call, overriding the earlier by-side
      // scheme): net of commission for a closed trade (matches
      // sim_history's own netPL convention), live unrealised P/L while
      // still open so the color can flip as price moves.
      const netPnL = stillOpen
        ? (pos.unrealisedPnL || 0)
        : ((pos.realisedPnL || 0) - (pos.commissionPaid || 0));
      want.set(pos.id, {
        entryTs: entryBar.timestamp,
        entryValue: pos.avgEntryPrice,
        endTs,
        endValue,
        color: netPnL < 0 ? lossColor : winColor,
      });
    }

    for (const [posId, chartId] of idBy.entries()) {
      if (!want.has(posId)) {
        try { chart.removeOverlay(chartId); } catch (e) { /* ignore */ }
        idBy.delete(posId);
      }
    }
    for (const [posId, info] of want.entries()) {
      const points = [
        { timestamp: info.entryTs, value: info.entryValue },
        { timestamp: info.endTs, value: info.endValue },
      ];
      const ext = { color: info.color };
      const existing = idBy.get(posId);
      if (existing) {
        try { chart.overrideOverlay({ id: existing, points, extendData: ext }); }
        catch (e) { /* ignore */ }
      } else {
        try {
          const newId = chart.createOverlay({ name: 'sim_trade_link', points, extendData: ext });
          if (newId) idBy.set(posId, newId);
        } catch (e) { /* ignore */ }
      }
    }
  }

  function _syncBrackets(chart, eng, opts) {
    // opts (mini-chart parallel — same pattern as _syncTradeArrows /
    // _syncPositionDuration): { idBy, entryIdBy, branchId, readOnly }.
    //   - idBy / entryIdBy : per-chart overlay-id maps so main + mini
    //       don't clobber each other's band / entry-line overlays.
    //       Default to the main-chart maps.
    //   - branchId : when set, only draw positions on that branch (the
    //       mini shows the miniBranchId timeline). Main passes none →
    //       no filter, unchanged behaviour.
    //   - readOnly : lock created overlays so the sub-chart's bands
    //       aren't draggable (display mirror, not editable).
    const bandIdBy       = (opts && opts.idBy)      || _bandIdBy;
    const entryIdBy      = (opts && opts.entryIdBy) || _entryLineIdBy;
    const filterBranchId = (opts && opts.branchId)  || null;
    const readOnly       = !!(opts && opts.readOnly);
    // Multi-timeframe panes have no DOM ticket rail of their own (that
    // UI is main-chart-only, see pane_manager.js's own doc comment) —
    // the USD P/L per leg and the entry's R/R ratio are otherwise only
    // visible on the main chart's tickets. opts.showLabels (set only by
    // the pane sync path in sync()) turns on small canvas text chips for
    // both so a pane reader doesn't have to glance back at the main
    // chart / side panel to read them. Main + mini stay exactly as
    // before (DOM ticket already shows this on main; mini wasn't asked
    // for and doubling main's ticket with a canvas label would just be
    // visual clutter sitting under it).
    const showLabels     = !!(opts && opts.showLabels);
    // Committed legs on the main (editable) chart use the draggable
    // template variant; the read-only mini keeps the plain locked one.
    const dragSuffix     = readOnly ? '' : '_drag';
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
    // Anchor X for the band overlay's draggable point. Defaults to the
    // MAIN chart's latest bar (getLatestBar()) so the handle sits near
    // the chart's right edge (TradingView-style). opts.anchorTs
    // overrides this — required for a multi-timeframe pane, whose own
    // bar series covers a different (and during replay, possibly much
    // narrower) time range than the main chart's; anchoring to a
    // timestamp outside that pane's own data would misplace or fail to
    // attach the draggable point on that instance.
    const latest = (window.SimController && window.SimController.getLatestBar)
      ? window.SimController.getLatestBar() : null;
    const anchorTs = Number.isFinite(opts && opts.anchorTs)
      ? opts.anchorTs
      : (latest ? latest.timestamp : null);

    // ----- Entry lines -------------------------------------------------
    // One per open position. Sync first so it sits BENEATH the bracket
    // bands in the overlay z-order (KLineChart renders overlays in
    // creation order; later overlays paint on top).
    const wantEntry = new Map();   // positionId → { ts, value, side }
    for (const pos of eng.getPositions()) {
      if (filterBranchId && pos.branchId !== filterBranchId) continue;
      const eo = (pos.entryOrderIds && pos.entryOrderIds.length)
        ? eng.getOrder(pos.entryOrderIds[0]) : null;
      if (!eo || !Number.isFinite(eo.filledAtBarTs)) continue;
      wantEntry.set(pos.id, {
        ts: eo.filledAtBarTs,
        value: pos.avgEntryPrice,
        side: pos.side,
      });
    }
    for (const [posId, chartId] of entryIdBy.entries()) {
      if (!wantEntry.has(posId)) {
        try { chart.removeOverlay(chartId); } catch (e) { /* ignore */ }
        entryIdBy.delete(posId);
      }
    }
    // Actually creating/updating the entry-line overlays from wantEntry
    // is DEFERRED to after the band loop below — that loop is where
    // rrLabel (R/R text, showLabels-gated) gets computed and stamped
    // onto each wantEntry entry, reusing the same tp/sl-children lookup
    // instead of doing it twice.

    // ----- Adjusted break-even lines -----------------------------------
    // Mirror the entry-line sync, but only WANT a line for positions whose
    // banked realised P/L has shifted the break-even at least half a tick
    // off the entry (below entry when banked profit on a long, above on a
    // short). When realised P/L is 0 the adjusted BE coincides with the
    // entry line, so we draw nothing and let the entry line stand in.
    const beIdBy = (opts && opts.beIdBy) || _beLineIdBy;
    const t_ = (window.I18n && window.I18n.t) || ((k) => k);
    const tick = spec.tickSize || 0.01;
    const wantBe = new Map();   // positionId → { ts, value, label }
    for (const pos of eng.getPositions()) {
      if (filterBranchId && pos.branchId !== filterBranchId) continue;
      const eo = (pos.entryOrderIds && pos.entryOrderIds.length)
        ? eng.getOrder(pos.entryOrderIds[0]) : null;
      if (!eo || !Number.isFinite(eo.filledAtBarTs)) continue;
      const R = pos.realisedPnL;
      if (!Number.isFinite(R) || Math.abs(R) < 1e-9 || pos.qty <= 1e-9) continue;
      const dir = pos.side === 'long' ? 1 : -1;
      const shift = R / (pos.qty * dir * pv * lot);
      if (!Number.isFinite(shift) || Math.abs(shift) < tick * 0.5) continue;
      const adjBe = pos.avgEntryPrice - shift;
      wantBe.set(pos.id, {
        ts: eo.filledAtBarTs,
        value: adjBe,
        label: t_('sim.beAdjLabel') + ' ' + adjBe.toFixed(2),
      });
    }
    for (const [posId, chartId] of beIdBy.entries()) {
      if (!wantBe.has(posId)) {
        try { chart.removeOverlay(chartId); } catch (e) { /* ignore */ }
        beIdBy.delete(posId);
      }
    }
    for (const [posId, info] of wantBe.entries()) {
      const points = [{ timestamp: info.ts, value: info.value }];
      const ext = { label: info.label };
      const existing = beIdBy.get(posId);
      if (existing) {
        try { chart.overrideOverlay({ id: existing, points, extendData: ext }); }
        catch (e) { /* ignore */ }
      } else {
        try {
          const espec = { name: 'sim_be_line', points, extendData: ext };
          if (readOnly) espec.lock = true;
          const newId = chart.createOverlay(espec);
          if (newId) beIdBy.set(posId, newId);
        } catch (e) { /* ignore */ }
      }
    }

    for (const pos of eng.getPositions()) {
      if (filterBranchId && pos.branchId !== filterBranchId) continue;
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
      // "drafting" = the user is actively placing / re-editing the FIRST
      // leg via the DOM ticket (pending or editing). Only then do we show
      // the single scalar ps.tp/ps.sl draft band. Once ARMED (committed) —
      // or when there's no proposal at all — we render EVERY committed
      // child as its own draggable band, so added TP2/TP3 legs appear and
      // can be dragged. (Previously armed was lumped in with drafting, so
      // multi-segment legs never drew until the proposal went away.)
      const drafting = inProposal && (phase === 'pending' || phase === 'editing');

      // Shared band emitter for a single exit leg. `childId` is the engine
      // order id for a COMMITTED leg (null for the in-proposal draft leg) —
      // it makes the band draggable and tells the drag handler which order
      // to re-price on release.
      const emitBand = (key, template, leg, exitPrice, legQty, dragging, invalid, childId, dim) => {
        const usd = (exitPrice - pos.avgEntryPrice) * dir * legQty * pv * lot;
        want.set(key, {
          template,
          exitPrice,
          ext: {
            leg, dragging, phase, invalid,
            dim: !!dim,
            usdLabel: fmtUSD(usd),
            showLabel: showLabels,
            qty: legQty,
            entryPrice: pos.avgEntryPrice,
            entryTs, anchorTs,
            childOrderId: (childId != null) ? childId : null,
          },
        });
      };

      // -------- TP --------
      // In an active proposal, the single draggable primary leg (ps.tp).
      // Committed, render EVERY TP leg as its own band (multi-segment
      // reduce-only brackets) with the leg's own qty — so the user sees
      // "TP1 = 1 lot / TP2 = 1 lot" and the runner's remaining size.
      // Also tracks the qty-weighted avg |TP - entry| distance (reward)
      // for the R/R label below — same "average across all TP legs"
      // formula sim_panel.js's DOM entry ticket uses.
      let rewardSum = 0, rewardQty = 0, slPriceForRR = null;
      if (drafting && Number.isFinite(ps.tp)) {
        emitBand(`${pos.id}.tp`, 'sim_bracket_band_tp', 'tp', ps.tp, pos.qty,
          !!(ps.draggingLeg === 'tp'), validity.tp === 'invalid');
        rewardSum = Math.abs(ps.tp - pos.avgEntryPrice) * pos.qty;
        rewardQty = pos.qty;
      } else if (!drafting) {
        // Nearest-to-entry TP is the ACTIVE target (full opacity); farther
        // TPs are dimmed. As each TP fills its band drops and the next one
        // becomes nearest → brightens automatically. (user spec: "TP1 亮,
        // TP2 半透明; TP1 到了就換 TP2 亮起".)
        const tpChildren = eng.getPendingOrders().filter(
          o => o.bracketParentId === entryOrder.id && o.type === 'limit')
          .sort((a, b) => Math.abs(a.price - pos.avgEntryPrice) - Math.abs(b.price - pos.avgEntryPrice));
        tpChildren.forEach((child, i) => {
          emitBand(`${pos.id}.tp.${child.id}`, 'sim_bracket_band_tp' + dragSuffix, 'tp',
            child.price, child.qty, false, false, child.id, i > 0);
          rewardSum += Math.abs(child.price - pos.avgEntryPrice) * child.qty;
          rewardQty += child.qty;
        });
      }

      // -------- SL --------
      if (drafting && Number.isFinite(ps.sl)) {
        emitBand(`${pos.id}.sl`, 'sim_bracket_band_sl', 'sl', ps.sl, pos.qty,
          !!(ps.draggingLeg === 'sl'), validity.sl === 'invalid');
        slPriceForRR = ps.sl;
      } else if (!drafting) {
        const slChildren = eng.getPendingOrders().filter(
          o => o.bracketParentId === entryOrder.id && o.type === 'stop');
        for (const child of slChildren) {
          emitBand(`${pos.id}.sl.${child.id}`, 'sim_bracket_band_sl' + dragSuffix, 'sl',
            child.stopPrice, child.qty, false, false, child.id);
        }
        if (slChildren.length) slPriceForRR = slChildren[0].stopPrice;
      }

      // R/R label on the entry line (showLabels-gated — see the opt's
      // doc comment above). Needs both legs present, same as the DOM
      // ticket's rule; qty/pv/lot cancel out of the ratio so raw price
      // distances are enough.
      if (showLabels) {
        const wantEntryInfo = wantEntry.get(pos.id);
        if (wantEntryInfo && rewardQty > 0 && Number.isFinite(slPriceForRR)) {
          const reward = rewardSum / rewardQty;
          const risk = Math.abs(pos.avgEntryPrice - slPriceForRR);
          const rr = risk > 0 ? reward / risk : 0;
          wantEntryInfo.rrLabel = rr > 0 ? `R/R ${rr.toFixed(2)}` : null;
        }
      }
    }

    // Create/update the entry-line overlays now that rrLabel (if any)
    // has been stamped onto each wantEntry entry above.
    for (const [posId, info] of wantEntry.entries()) {
      const points = [{ timestamp: info.ts, value: info.value }];
      const ext = { side: info.side, rrLabel: info.rrLabel || null };
      const existing = entryIdBy.get(posId);
      if (existing) {
        try { chart.overrideOverlay({ id: existing, points, extendData: ext }); }
        catch (e) { /* ignore */ }
      } else {
        try {
          const espec = { name: 'sim_entry_line', points, extendData: ext };
          if (readOnly) espec.lock = true;
          const newId = chart.createOverlay(espec);
          if (newId) entryIdBy.set(posId, newId);
        } catch (e) { /* ignore */ }
      }
    }

    // Drop bands no longer wanted.
    for (const [key, chartId] of bandIdBy.entries()) {
      if (!want.has(key)) {
        try { chart.removeOverlay(chartId); } catch (e) { /* ignore */ }
        bandIdBy.delete(key);
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
      const existing = bandIdBy.get(key);
      if (existing) {
        try { chart.overrideOverlay({ id: existing, points, extendData: info.ext }); }
        catch (e) { /* ignore */ }
      } else {
        try {
          const bspec = { name: info.template, points, extendData: info.ext };
          // A committed leg on the MAIN chart is draggable (grab the line
          // to re-price → _onBracketDragEnd → modifyOrder). The in-proposal
          // draft leg stays DOM-ticket-driven (locked), and every leg on
          // the read-only mini stays locked.
          const draggable = !readOnly && info.ext.childOrderId != null;
          bspec.lock = !draggable;
          const newId = chart.createOverlay(bspec);
          if (newId) bandIdBy.set(key, newId);
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
    drop(_beLineIdBy);
    drop(_tradeLinkIdBy);
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

  /** Console debugging aid: for every trade-arrow event (entry + each
   *  exit leg) on every position, report — for the MAIN chart and every
   *  multi-timeframe pane — which bar `_findBarByTimestamp` resolves it
   *  to (using that chart's own bars, exactly like sync() does) and the
   *  resulting screen pixel (via that chart's own convertToPixel), side
   *  by side with the order's raw filledAtBarTs/fillPrice. Run
   *  `SimOverlays.debugArrows()` in the console (table logged AND
   *  returned) after placing/closing a trade with multi-pane mode on —
   *  lets you compare "which K-bar did each pane actually land the
   *  triangle on" without guessing from screenshots. Read-only: doesn't
   *  create/touch any overlay. */
  function debugArrows() {
    const eng = window.SimController && window.SimController.engine;
    if (!eng) { console.warn('[SimOverlays.debugArrows] no engine'); return null; }
    const charts = [];
    const main = _chart();
    if (main) charts.push({ label: 'main', chart: main, bars: null }); // null → _findBarByTimestamp's own default resolution
    const PM = window.PaneManager;
    if (PM && Array.isArray(PM.panes)) {
      for (const pane of PM.panes) {
        if (!pane.chart) continue;
        charts.push({
          label: `pane tf=${pane.tf} id=${pane.id}`,
          chart: pane.chart,
          bars: pane.chart.getDataList ? pane.chart.getDataList() : null,
        });
      }
    }
    const rows = [];
    const describe = (chartInfo, posId, event, order) => {
      if (!order || !Number.isFinite(order.filledAtBarTs)) return;
      const bar = _findBarByTimestamp(order.filledAtBarTs, chartInfo.bars);
      let px = null;
      if (bar) {
        try {
          px = chartInfo.chart.convertToPixel(
            [{ timestamp: bar.timestamp, value: order.fillPrice }],
            { paneId: 'candle_pane' }
          );
        } catch (e) { /* ignore */ }
      }
      rows.push({
        chart: chartInfo.label,
        posId, event, orderId: order.id,
        filledAtBarISO: new Date(order.filledAtBarTs).toISOString(),
        fillPrice: order.fillPrice,
        resolvedBarISO: bar ? new Date(bar.timestamp).toISOString() : null,
        resolvedBarLow: bar ? bar.low : null,
        resolvedBarHigh: bar ? bar.high : null,
        pixelX: px && px[0] ? px[0].x : null,
        pixelY: px && px[0] ? px[0].y : null,
      });
    };
    const allPositions = eng.getPositions().concat(eng.getPositionHistory());
    for (const pos of allPositions) {
      const entryOrder = pos.entryOrderIds && pos.entryOrderIds.length
        ? eng.getOrder(pos.entryOrderIds[0]) : null;
      for (const c of charts) describe(c, pos.id, 'entry', entryOrder);
      for (const exId of (pos.exitOrderIds || [])) {
        const exitOrder = eng.getOrder(exId);
        for (const c of charts) describe(c, pos.id, 'exit', exitOrder);
      }
    }
    if (console.table) console.table(rows); else console.log(rows);
    return rows;
  }

  window.SimOverlays = {
    sync, clearAll, previewOrderPrice, _registerTemplates, dropPaneMaps,
    debugArrows,
  };
})();
