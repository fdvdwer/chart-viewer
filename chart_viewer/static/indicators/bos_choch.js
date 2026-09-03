/* ============================================================================
 * bos_choch.js — BOS / CHoCh structure-event detector (Phase 3 main)
 * ============================================================================
 * Spec: docs/specs/bos-choch-spec.md
 *
 * Walks an N-Wave-style alternating pivot sequence + the current-TF dataList,
 * tracks trend state ('up' | 'down' | 'unknown'), and emits structural events
 * whenever a bar's close (or wick, per `require_close_break`) crosses the
 * most recent unbroken swing high (for upward break) or swing low (for
 * downward break).
 *
 * Event classification (spec §2.3):
 *   break direction  trend before     event type
 *   up               up               BOS up        (with-trend continuation)
 *   up               down             CHoCh up      (counter-trend, flips trend)
 *   down             down             BOS down
 *   down             up               CHoCh down
 *
 * §1-1 enforcement (Wister 上課概念 §1-1, toggleable):
 *   - 多頭 CHoCh ↓ (in uptrend, a low got broken) only counts if the broken
 *     low.price < the most recent BOS up's level (so the CHoCh is genuinely
 *     "lower" structure). Otherwise it's a retrace/inducement → suppress.
 *   - 空頭 CHoCh ↑ mirror.
 *
 * NO LOOKAHEAD: events are emitted at the BREAK bar (= eventBarIdx). In
 * replay mode, KLineChart truncates dataList at cursor → walker stops at
 * cursor → events past cursor never emit. Free property, do not break.
 *
 * Dependency: window.NWaveIndicator must be loaded first (provides
 * detectAlternatingSequence + applyAmplitudeFilter pure functions). Script
 * ordering in index.html ensures this.
 *
 * Output API (for Phase 3c CHoChZoneFib + Phase 6 AI mentor):
 *   window.BOSChoChDetector.detectEvents(dataList, params) → events[]
 *   window.BOSChoChDetector.getEventsForChart(chart)       → events[]
 * ========================================================================== */

(function () {
  const TYPE_NAME = 'bos_choch';
  const KLC_NAME  = 'BOSChoCh';

  // ---- Track event lists per (chart, paneId) so getEventsForChart works ----
  const _eventsByPaneKey = new Map();   // "paneId" -> events[]
  function _paneKey(paneId) { return paneId || 'candle_pane'; }

  // ---- Defaults / schema ----
  const DEFAULT_PARAMS = {
    left_strength:    1,
    right_strength:   1,
    min_swing_amount: 0,
    swing_unit:       'absolute',

    require_close_break:     true,
    enforce_choch_below_bos: true,

    show_bos:               true,
    show_choch:             true,
    show_broken_level:      true,
    level_line_extend:      'event',     // 'event' | 'forward' | 'both' — default = pivot→break only
    level_line_decay:       false,
    bos_color:              '#26a69a',
    choch_color:            '#ef5350',
    marker_text_size:       12,
    label_color:            '#ffffff',   // text on top of (dashed/solid) line
  };

  const SWING_UNIT_OPTIONS = [
    { value: 'absolute', label: '價格點' },
    { value: 'pct',      label: '百分比 %' },
  ];

  const LINE_EXTEND_OPTIONS = [
    { value: 'event',   label: 'event 短線（pivot → 破口）' },
    { value: 'forward', label: 'forward 往右延伸' },
    { value: 'both',    label: 'both 全圖橫線' },
  ];

  const PARAM_SCHEMA = [
    { type: 'section', label: '結構偵測（共用 N Wave 演算法）' },
    { key: 'left_strength',    label: 'LeftStrength',   type: 'int',    min: 1, max: 50, default: 1 },
    { key: 'right_strength',   label: 'RightStrength',  type: 'int',    min: 1, max: 50, default: 1 },
    { key: 'min_swing_amount', label: '最小擺動',        type: 'number', min: 0,          default: 0 },
    { key: 'swing_unit',       label: '單位',            type: 'enum',   options: SWING_UNIT_OPTIONS, default: 'absolute' },

    { type: 'section', label: '事件規則' },
    { key: 'require_close_break',     label: '收盤價突破才算',         type: 'bool', default: true },
    { key: 'enforce_choch_below_bos', label: '§1-1 多頭 CHoCh < BOS', type: 'bool', default: true },

    { type: 'section', label: '顯示' },
    { key: 'show_bos',          label: '顯示 BOS',     type: 'bool', default: true },
    { key: 'show_choch',        label: '顯示 CHoCh',   type: 'bool', default: true },
    { key: 'show_broken_level', label: '被破水平線',    type: 'bool', default: true },
    { key: 'level_line_extend', label: '線延伸方式',    type: 'enum', options: LINE_EXTEND_OPTIONS, default: 'forward' },
    { key: 'level_line_decay',  label: '破口後淡化',    type: 'bool', default: false },
    { key: 'bos_color',         label: 'BOS 顏色',     type: 'color', default: '#26a69a' },
    { key: 'choch_color',       label: 'CHoCh 顏色',   type: 'color', default: '#ef5350' },
    { key: 'label_color',       label: 'Label 顏色',   type: 'color', default: '#ffffff' },
    { key: 'marker_text_size',  label: 'Marker 字級',  type: 'int', min: 8, max: 18, default: 12 },
  ];

  // ===========================================================================
  // Core detection — pure function, no DOM / chart access
  // ===========================================================================

  // Resolve the initial trend by sliding a 4-pivot window over the seq.
  // Four consecutive (alternating) pivots give 2 highs + 2 lows:
  //   higher-high + higher-low → 'up';  lower-high + lower-low → 'down'.
  // The FIRST decidable window wins, and the trend becomes "known" only once
  // that window's latest pivot is CONFIRMED (barIdx + R).
  //
  // Why a SLIDING window (not just the first 2H+2L, spec §2.1): a choppy
  // OPENING (e.g. an expanding HH+LL) made the old _decideInitialTrend return
  // 'unknown' on the very first window, and it was never re-evaluated → the
  // whole detector emitted 0 events forever (PROGRESS §4zm: 15m / coarse-TF
  // dead-zones, and the repeated "0 events" in node windows). Scanning forward
  // anchors the trend at the first clean structure instead. For a clean opening
  // this is identical to the old "first 2H+2L" decision + ready bar.
  //
  // Returns { trend: 'up'|'down'|'unknown', readyAt: barIdx|Infinity }.
  function _resolveInitialTrend(seq, R) {
    for (let i = 3; i < seq.length; i++) {
      const w = [seq[i - 3], seq[i - 2], seq[i - 1], seq[i]];
      const highs = w.filter(p => p.type === 'high');
      const lows  = w.filter(p => p.type === 'low');
      if (highs.length !== 2 || lows.length !== 2) continue;   // non-alternating guard
      const h0 = highs[0], h1 = highs[1], l0 = lows[0], l1 = lows[1];
      let trend = 'unknown';
      if (h1.price > h0.price && l1.price > l0.price) trend = 'up';
      else if (h1.price < h0.price && l1.price < l0.price) trend = 'down';
      if (trend !== 'unknown') return { trend, readyAt: seq[i].barIdx + (R | 0) };
    }
    return { trend: 'unknown', readyAt: Infinity };
  }

  /**
   * Run the state machine.
   *
   * @param {Array}  seq        alternating pivot sequence (from NWave detect+amp)
   * @param {Array}  dataList   current-TF bars (KLineChart-style {timestamp, open, high, low, close, volume})
   * @param {Object} params     param object (DEFAULT_PARAMS shape)
   * @returns {Array} events    [{type, direction, pivotBarIdx, pivotTs, level, eventBarIdx, eventTs, trendBefore}, ...]
   */
  function detectEventsFromSeq(seq, dataList, params) {
    if (!Array.isArray(seq) || seq.length < 2) return [];
    if (!Array.isArray(dataList) || dataList.length === 0) return [];

    const R = params.right_strength | 0;
    const requireClose = !!params.require_close_break;
    const enforce11 = !!params.enforce_choch_below_bos;

    const events = [];
    const state = {
      trend:     'unknown',  // 'up' | 'down' | 'unknown'
      // UNBROKEN swing highs / lows (not a single slot). In a downtrend the
      // highs pile up as a descending staircase of lower-highs; one strong
      // up-bar can break SEVERAL at once. Keeping them all lets us resolve the
      // break to the MOST SIGNIFICANT (highest) level broken, not just the
      // nearest — so a CHoCh/BOS marks the biggest structure the bar took out,
      // and the supply/demand zone anchors there (user 2026-05).
      pendingHighs: [],      // [{ barIdx, price }]
      pendingLows:  [],
      recentHigh:   null,    // most-recently-activated high  (OB pivot on down-break)
      recentLow:    null,    // most-recently-activated low   (OB pivot on up-break)
      lastBOS:   null,       // last emitted BOS event, used for §1-1 check
      lastCHoCh: null,
    };

    // Cache of confirmation bars so we activate each pivot at pivot.barIdx + R.
    // The pivot itself sits at pivot.barIdx but is only "known" R bars later.
    const seqWithConfirm = seq.map(p => ({ ...p, confirmBarIdx: p.barIdx + R }));
    let pivotIdx = 0;

    const initTrend = _resolveInitialTrend(seq, R);
    const trendReadyAt = initTrend.readyAt;
    // The walker only starts evaluating breaks once initial trend is decidable.

    const n = dataList.length;
    for (let K = 0; K < n; K++) {
      const bar = dataList[K];
      if (!bar) continue;
      // REPLAY SAFETY: stop processing as soon as we hit a placeholder
      // bar (per replay.js convention — flat synthetic OHLC). Without
      // this guard, a placeholder's close (= fillPrice) might falsely
      // exceed a swingHigh / swingLow and emit a spurious event that
      // only exists during replay. Same root cause as the N Wave
      // detector's placeholder handling.
      if (bar._placeholder) break;

      // (1) Activate any pivots whose confirmation bar == K.
      //     They become eligible for break detection from this bar forward.
      while (pivotIdx < seqWithConfirm.length && seqWithConfirm[pivotIdx].confirmBarIdx <= K) {
        const p = seqWithConfirm[pivotIdx];
        const pv = { barIdx: p.barIdx, price: p.price };
        if (p.type === 'high') {
          // A new high ABOVE pending lower-highs means price already rallied
          // through them → they're broken (the bar-by-bar check fired them if
          // the trend was known by then; otherwise they're historical and must
          // NOT re-fire). Drop them, keeping pendingHighs a descending staircase
          // of still-unbroken lower-highs.
          state.pendingHighs = state.pendingHighs.filter(h => h.price >= pv.price);
          state.pendingHighs.push(pv);
          state.recentHigh = pv;
        } else {
          state.pendingLows = state.pendingLows.filter(l => l.price <= pv.price);
          state.pendingLows.push(pv);
          state.recentLow = pv;
        }
        pivotIdx++;
      }

      // (2) Lock in the (precomputed) initial trend once its deciding window
      //     is confirmed. Stays 'unknown' forever only if NO window in the
      //     whole seq is decidable (genuinely structureless — see test 7).
      if (state.trend === 'unknown' && K >= trendReadyAt) {
        state.trend = initTrend.trend;
      }
      if (state.trend === 'unknown') continue;

      // (3) Check for breaks at this bar. A single bar can take out several
      //     pending levels; resolve to the MOST SIGNIFICANT (highest high for
      //     an up-break / lowest low for a down-break) and consume them all.

      // Up-side break — strictly above (matches the old `>`).
      if (state.pendingHighs.length) {
        const refPrice = requireClose ? bar.close : bar.high;
        let target = null;
        for (const h of state.pendingHighs) {
          if (refPrice > h.price && (!target || h.price > target.price)) target = h;
        }
        if (target) {
          _tryEmit(events, state, 'up', K, bar, dataList, enforce11, target);
          state.pendingHighs = state.pendingHighs.filter(h => !(refPrice > h.price));
        }
      }

      // Down-side break — strictly below.
      if (state.pendingLows.length) {
        const refPrice = requireClose ? bar.close : bar.low;
        let target = null;
        for (const l of state.pendingLows) {
          if (refPrice < l.price && (!target || l.price < target.price)) target = l;
        }
        if (target) {
          _tryEmit(events, state, 'down', K, bar, dataList, enforce11, target);
          state.pendingLows = state.pendingLows.filter(l => !(refPrice < l.price));
        }
      }
    }

    return events;
  }

  function _tryEmit(events, state, direction, eventBarIdx, bar, dataList, enforce11, pivot) {
    const eventType = (direction === state.trend) ? 'BOS' : 'CHoCh';
    // `pivot` = the resolved broken level (the most significant one this bar
    // took out — see the walker). Order-block pivot = the OPPOSITE swing still
    // active at the break — the
    // last pullback before price broke out. Bull break → the pullback LOW
    // (where the demand OB sits); bear break → the pullback HIGH (supply OB).
    // NOTE: this is NOT the pivot before the broken pivot in the seq — the
    // broken pivot can be much OLDER than the immediate pre-breakout pullback
    // (e.g. a BOS up breaks an old high while the fresh pullback low sits
    // AFTER that high). Carrying it on the event lets SupplyDemandZones anchor
    // the OB on the correct candle.
    const obPivot = (direction === 'up') ? state.recentLow : state.recentHigh;

    // §1-1 enforcement on CHoCh only — does it pass the level constraint?
    if (enforce11 && eventType === 'CHoCh' && state.lastBOS) {
      // 空頭 CHoCh ↓ in an uptrend: broken low must be BELOW lastBOS.level (BOS up's broken-high price).
      // 多頭 CHoCh ↑ in a downtrend: broken high must be ABOVE lastBOS.level (BOS down's broken-low price).
      if (direction === 'down' && state.lastBOS.direction === 'up' && pivot.price >= state.lastBOS.level) {
        return;  // suppressed: this "CHoCh" is actually a higher-low, just an internal retrace
      }
      if (direction === 'up' && state.lastBOS.direction === 'down' && pivot.price <= state.lastBOS.level) {
        return;  // suppressed: lower-high inside a downtrend
      }
    }

    const event = {
      type:        eventType,
      direction:   direction,
      pivotBarIdx: pivot.barIdx,
      pivotTs:     dataList[pivot.barIdx] ? dataList[pivot.barIdx].timestamp : null,
      level:       pivot.price,
      eventBarIdx: eventBarIdx,
      eventTs:     bar.timestamp,
      trendBefore: state.trend,
      // OB / origin pivot (pullback) — see comment above.
      obPivotBarIdx: obPivot ? obPivot.barIdx : null,
      obPivotPrice:  obPivot ? obPivot.price  : null,
    };
    events.push(event);

    if (eventType === 'BOS') {
      state.lastBOS = event;
      // Trend stays put.
    } else {
      state.lastCHoCh = event;
      state.trend = direction;   // CHoCh flips trend
      // Fresh structural leg: reset the pending staircases so subsequent breaks
      // resolve within the NEW leg only. Without this, an unbroken pivot from a
      // long-gone leg lingers and a later deep break matches it (a CHoCh that
      // reached an 18-day-old low). The within-leg accumulation that lets one
      // bar pick the biggest of several lower-highs is preserved — only the
      // cross-flip carry-over is dropped.
      state.pendingHighs = [];
      state.pendingLows = [];
    }
  }

  // Wrapper that takes raw dataList + indicator params and produces events.
  // First runs the NWave pivot detector + amplitude filter, then the state machine.
  //
  // FAIL LOUD: both detectAlternatingSequence and applyAmplitudeFilter must be
  // exported by NWaveIndicator. Earlier versions only exported the detector,
  // and bos_choch.js silently skipped the amplitude filter — which meant
  // changing `min_swing_amount` in the settings dialog did nothing. Don't
  // re-introduce the silent-skip pattern.
  function detectEvents(dataList, params) {
    const N = window.NWaveIndicator;
    if (!N || typeof N.detectAlternatingSequence !== 'function' || typeof N.applyAmplitudeFilter !== 'function') {
      console.warn('[BOSChoChDetector] NWaveIndicator dependency missing or incomplete (need detectAlternatingSequence + applyAmplitudeFilter)');
      return [];
    }
    let seq = N.detectAlternatingSequence(dataList, params.left_strength, params.right_strength);
    seq = N.applyAmplitudeFilter(seq, Number(params.min_swing_amount) || 0, params.swing_unit);
    return detectEventsFromSeq(seq, dataList, params);
  }

  // ===========================================================================
  // Rendering helpers
  // ===========================================================================

  function _withAlpha(hex, alpha) {
    if (!hex) return `rgba(0,0,0,${alpha})`;
    if (hex.startsWith('rgba')) {
      // Already rgba — replace the alpha
      const parts = hex.match(/[\d.]+/g);
      if (parts && parts.length >= 4) {
        return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
      }
      return hex;
    }
    if (hex.startsWith('#') && hex.length === 7) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    return hex;
  }

  function _labelText(event) {
    // Bold italic upper-case label drawn ON the level line, centered between
    // pivot and break bar. Matches the SMC convention in the user's
    // reference image (text intrudes into the line, no background box).
    return event.type === 'BOS' ? 'BOS' : 'CHOCH';
  }

  // Combined renderer: draws the horizontal level line WITH a gap around
  // the centered text label. Calls draw the line in TWO segments (left of
  // text + right of text) so the text sits cleanly in the middle without
  // a background box.
  function _drawEventVisual(ctx, event, ext, xAxis, yAxis, kLineDataList) {
    const color     = event.type === 'BOS' ? (ext.bos_color || DEFAULT_PARAMS.bos_color)
                                           : (ext.choch_color || DEFAULT_PARAMS.choch_color);
    const lblColor  = ext.label_color || DEFAULT_PARAMS.label_color;
    const fontSize  = Number(ext.marker_text_size) || DEFAULT_PARAMS.marker_text_size;
    const lineStyle = event.type === 'CHoCh' ? 'dashed' : 'solid';
    const decay     = !!ext.level_line_decay;
    const showLine  = ext.show_broken_level !== false;
    const extendMode = ext.level_line_extend || DEFAULT_PARAMS.level_line_extend;

    const y = yAxis.convertToPixel(event.level);
    if (!Number.isFinite(y)) return;

    // X bounds of the horizontal line (extend mode controls right edge).
    const n = kLineDataList.length;
    let leftIdx, rightIdx;
    if      (extendMode === 'both')    { leftIdx = 0;                    rightIdx = n - 1; }
    else if (extendMode === 'forward') { leftIdx = event.pivotBarIdx;    rightIdx = n - 1; }
    else                               { leftIdx = event.pivotBarIdx;    rightIdx = event.eventBarIdx; }

    const xLeft  = xAxis.convertToPixel(leftIdx);
    const xRight = xAxis.convertToPixel(rightIdx);
    const xPivot = xAxis.convertToPixel(event.pivotBarIdx);
    const xEvent = xAxis.convertToPixel(event.eventBarIdx);
    if (!Number.isFinite(xLeft) || !Number.isFinite(xRight) || !Number.isFinite(xPivot) || !Number.isFinite(xEvent)) return;

    // Label position = midpoint between pivot and break bar.
    const centerX = (xPivot + xEvent) / 2;

    ctx.save();

    // Measure text first (need width to compute line gap around it).
    ctx.font = `bold italic ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = _labelText(event);
    const textMetrics = ctx.measureText(label);
    const halfGap = textMetrics.width / 2 + 8;   // 8px padding each side
    const textLeftX  = centerX - halfGap;
    const textRightX = centerX + halfGap;

    if (showLine) {
      ctx.lineWidth = 1;
      ctx.lineCap = 'butt';
      ctx.setLineDash(lineStyle === 'dashed' ? [6, 4] : []);

      // (a) Segment left of text (line up to textLeftX)
      const segA_left  = xLeft;
      const segA_right = Math.min(textLeftX, xEvent, xRight);
      if (segA_left < segA_right) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(segA_left, y);
        ctx.lineTo(segA_right, y);
        ctx.stroke();
      }

      // (b) Segment between text and event bar (only if textRightX < xEvent)
      const segB_left  = Math.max(textRightX, xLeft);
      const segB_right = Math.min(xEvent, xRight);
      if (segB_left < segB_right) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(segB_left, y);
        ctx.lineTo(segB_right, y);
        ctx.stroke();
      }

      // (c) Post-event segment (only relevant when extend ≠ 'event'): event → right.
      //     Optionally decayed (alpha 40%).
      if (xEvent < xRight) {
        ctx.strokeStyle = decay ? _withAlpha(color, 0.40) : color;
        ctx.beginPath();
        ctx.moveTo(xEvent, y);
        ctx.lineTo(xRight, y);
        ctx.stroke();
      }

      ctx.setLineDash([]);
    }

    // Text on top (drawn AFTER line segments so it visually wins even if a
    // line was accidentally drawn through it). No background box — just
    // bold italic text in `label_color` (white by default for dark theme).
    ctx.fillStyle = lblColor;
    ctx.fillText(label, centerX, y);

    ctx.restore();
  }

  // ===========================================================================
  // KLineChart template
  // ===========================================================================

  function _buildKlineTemplate() {
    return {
      name: KLC_NAME,
      shortName: 'BOS / CHoCh',
      calcParams: [
        DEFAULT_PARAMS.left_strength,
        DEFAULT_PARAMS.right_strength,
        DEFAULT_PARAMS.min_swing_amount,
        DEFAULT_PARAMS.swing_unit,
        DEFAULT_PARAMS.require_close_break,
        DEFAULT_PARAMS.enforce_choch_below_bos,
      ],
      extendData: {
        // Detection params (also live in calcParams for diff/recalc, but
        // exposing them in extendData lets draw() read both detection and
        // visual params from one place).
        left_strength:           DEFAULT_PARAMS.left_strength,
        right_strength:          DEFAULT_PARAMS.right_strength,
        min_swing_amount:        DEFAULT_PARAMS.min_swing_amount,
        swing_unit:              DEFAULT_PARAMS.swing_unit,
        require_close_break:     DEFAULT_PARAMS.require_close_break,
        enforce_choch_below_bos: DEFAULT_PARAMS.enforce_choch_below_bos,
        // Visual params
        show_bos:           DEFAULT_PARAMS.show_bos,
        show_choch:         DEFAULT_PARAMS.show_choch,
        show_broken_level:  DEFAULT_PARAMS.show_broken_level,
        level_line_extend:  DEFAULT_PARAMS.level_line_extend,
        level_line_decay:   DEFAULT_PARAMS.level_line_decay,
        bos_color:          DEFAULT_PARAMS.bos_color,
        choch_color:        DEFAULT_PARAMS.choch_color,
        label_color:        DEFAULT_PARAMS.label_color,
        marker_text_size:   DEFAULT_PARAMS.marker_text_size,
      },
      styles: {
        tooltip: { showRule: 'none' },
      },
      // calc() returns array length === dataList.length per KLineChart contract.
      // We stash the events on slot 0 (same pattern as N Wave's seq). Per-bar
      // result entries stay null — we don't drive figures, the draw callback
      // iterates events[].
      calc(dataList, indicator) {
        const calcParams = (indicator && indicator.calcParams) || [];
        const ext        = (indicator && indicator.extendData) || {};
        const params = {
          left_strength:           calcParams[0] ?? ext.left_strength           ?? DEFAULT_PARAMS.left_strength,
          right_strength:          calcParams[1] ?? ext.right_strength          ?? DEFAULT_PARAMS.right_strength,
          min_swing_amount:        calcParams[2] ?? ext.min_swing_amount        ?? DEFAULT_PARAMS.min_swing_amount,
          swing_unit:              calcParams[3] || ext.swing_unit              || DEFAULT_PARAMS.swing_unit,
          require_close_break:     (calcParams[4] !== undefined ? calcParams[4] : (ext.require_close_break !== undefined ? ext.require_close_break : DEFAULT_PARAMS.require_close_break)),
          enforce_choch_below_bos: (calcParams[5] !== undefined ? calcParams[5] : (ext.enforce_choch_below_bos !== undefined ? ext.enforce_choch_below_bos : DEFAULT_PARAMS.enforce_choch_below_bos)),
        };
        const events = detectEvents(dataList, params);
        // Stash by indicator's paneId so getEventsForChart can look up —
        // UNLESS this instance is running on a multi-timeframe pane
        // (pane_manager.js), not the main chart. calc() has no visibility
        // into which chart instance called it (KLineChart doesn't pass one),
        // and every instance defaults to the same paneId ('candle_pane'),
        // so a pane's own recalc would silently clobber the main chart's
        // cached events out from under event_log.js. __pane_instance is
        // baked into extendData by pane_manager.js when mirroring
        // indicators onto a pane; the main chart never sets it.
        if (!ext.__pane_instance) {
          const pkey = _paneKey(indicator && indicator.paneId);
          _eventsByPaneKey.set(pkey, events);
        }
        const out = new Array(dataList.length).fill(null);
        if (out.length > 0) out[0] = { events };
        return out;
      },
      draw({ ctx, kLineDataList, indicator, visibleRange, xAxis, yAxis, bounding }) {
        const ext = (indicator && indicator.extendData) || {};
        if (ext.hidden === true) return false;
        const result = indicator && indicator.result;
        if (!Array.isArray(result) || result.length === 0) return false;
        const events = (result[0] && result[0].events) || [];
        if (!events.length) return false;

        const showBos    = ext.show_bos          !== false;
        const showChoch  = ext.show_choch        !== false;

        const from = visibleRange && visibleRange.realFrom != null ? visibleRange.realFrom : (visibleRange ? visibleRange.from : 0);
        const to   = visibleRange && visibleRange.realTo   != null ? visibleRange.realTo   : (visibleRange ? visibleRange.to   : kLineDataList.length - 1);

        for (const event of events) {
          if (event.type === 'BOS'   && !showBos)   continue;
          if (event.type === 'CHoCh' && !showChoch) continue;

          // Visible-range cull. Allow ±2 bars of slack so partially-visible
          // markers/lines at the viewport edges still render.
          const eb = event.eventBarIdx;
          const pb = event.pivotBarIdx;
          const extendMode = ext.level_line_extend || DEFAULT_PARAMS.level_line_extend;
          // Skip events whose entire visible footprint is past the viewport
          // right edge. For 'event' mode also skip if entirely left of viewport.
          if (pb > to + 2) continue;
          if (extendMode === 'event' && eb < from - 2) continue;

          // Combined draw: line segments + centered bold-italic label.
          _drawEventVisual(ctx, event, ext, xAxis, yAxis, kLineDataList);
        }
        return false;
      },
    };
  }

  // ===========================================================================
  // Indicator registration plumbing — same shape as N Wave / Swing Pivot
  // ===========================================================================

  function _paramsToCalc(p) {
    return [
      p.left_strength,
      p.right_strength,
      p.min_swing_amount,
      p.swing_unit,
      !!p.require_close_break,
      !!p.enforce_choch_below_bos,
    ];
  }

  function _paramsToExtend(p) {
    return {
      left_strength:           p.left_strength,
      right_strength:          p.right_strength,
      min_swing_amount:        p.min_swing_amount,
      swing_unit:              p.swing_unit,
      require_close_break:     !!p.require_close_break,
      enforce_choch_below_bos: !!p.enforce_choch_below_bos,
      show_bos:                p.show_bos !== false,
      show_choch:              p.show_choch !== false,
      show_broken_level:       p.show_broken_level !== false,
      level_line_extend:       p.level_line_extend || DEFAULT_PARAMS.level_line_extend,
      level_line_decay:        !!p.level_line_decay,
      bos_color:               p.bos_color   || DEFAULT_PARAMS.bos_color,
      choch_color:             p.choch_color || DEFAULT_PARAMS.choch_color,
      label_color:             p.label_color || DEFAULT_PARAMS.label_color,
      marker_text_size:        Number(p.marker_text_size) || DEFAULT_PARAMS.marker_text_size,
      __pane_instance:         !!p.__pane_instance,
    };
  }

  function add(chart, params) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    return chart.createIndicator({
      name: KLC_NAME,
      calcParams: _paramsToCalc(p),
      extendData: _paramsToExtend(p),
    }, true, { id: 'candle_pane' });
  }

  function remove(chart, paneId) {
    try {
      chart.removeIndicator({ name: KLC_NAME }, paneId || 'candle_pane');
    } catch (e) { /* ignore */ }
    _eventsByPaneKey.delete(_paneKey(paneId));
  }

  function applyParams(chart, paneId, params, visible) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    const ext = _paramsToExtend(p);
    if (visible === false) ext.hidden = true;
    try {
      chart.overrideIndicator({
        name: KLC_NAME,
        calcParams: _paramsToCalc(p),
        extendData: ext,
      }, paneId || 'candle_pane');
    } catch (e) { /* ignore */ }
  }

  // ---- Public API for downstream consumers (Phase 3c / Phase 6) ----
  function getEventsForChart(_chart, paneId) {
    // chart arg reserved for future multi-chart support; for now events are
    // keyed by paneId only since we only run on candle_pane.
    return _eventsByPaneKey.get(_paneKey(paneId)) || [];
  }

  // ---- Public registration ----
  window.BOSChoChDetector = {
    type:          TYPE_NAME,
    name:          'BOS / CHoCh',
    defaultParams: { ...DEFAULT_PARAMS },
    paramSchema:   PARAM_SCHEMA,
    klineTemplate: _buildKlineTemplate(),
    add,
    remove,
    applyParams,
    // Pure functions for tests / Phase 3c consumers:
    detectEvents,
    detectEventsFromSeq,
    getEventsForChart,
  };
})();
