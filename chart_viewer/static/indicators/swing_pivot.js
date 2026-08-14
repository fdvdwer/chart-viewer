/* ============================================================================
 * swing_pivot.js — Swing Pivot indicator (frontend port)
 * ============================================================================
 * Mirrors chart_viewer/indicators/swing_pivot.py byte-for-byte, so any pivot
 * that the Python ground-truth validator confirms ALSO confirms here when
 * the JS runs over the same OHLC bars. Same MC semantics:
 *
 *   HIGH pivot at K (strength L/R):
 *     left:  High[K-i] <= High[K]   for i in 1..L   (ties allowed)
 *     right: High[K+i] <  High[K]   for i in 1..R   (strict)
 *   LOW pivot at K  (mirror):
 *     left:  Low[K-i]  >= Low[K]
 *     right: Low[K+i]  >  Low[K]
 *
 *   Warmup: detection only runs for K >= L + R, so the earliest possible
 *   confirmation bar is K = L + R (0-indexed). Equivalently MC's
 *   BarIdx > L + R rule.
 *
 * REPLAY SAFETY (no-lookahead, per VISION.md §2):
 *   In replay mode the chart only holds bars up to the cursor (placeholders
 *   past cursor are zero-volume markers), and KLineChart re-runs calc()
 *   against that truncated dataList every time the replay cursor advances.
 *   So we get no-lookahead for free — at cursor C, only pivots whose
 *   confirmation bar K satisfies K <= C have been emitted by calc().
 *   The pivot itself sits at K-R (R bars earlier), but it ONLY appears
 *   when C reaches K — that's the "late-confirm" property pivots are
 *   supposed to have.
 *
 * KLineChart wiring:
 *   We register this as a KLineChart custom indicator stacked on the
 *   candle pane (`isStack: true`, `paneId: 'candle_pane'`). The `figures`
 *   declaration produces a 'circle' figure for highY (above the bar) and
 *   lowY (below the bar) — KLineChart only renders the figure on bars
 *   where the corresponding value is non-null.
 * ========================================================================== */

(function () {
  const TYPE_NAME = 'swing_pivot';      // our registry id (config.json type)
  const KLC_NAME  = 'SwingPivot';        // KLineChart indicator name

  // ---- Pure detector (bit-for-bit identical to swing_pivot.py) ----
  // Returns an array of `{ highY, lowY }` per bar. KLineChart treats null
  // values in figure-mapped keys as "do not render this bar," so the
  // highY/lowY price is set ONLY on the bars that ARE pivots.
  //
  // Subtle point: the MC ground truth writes the IsPivot flag on the
  // CONFIRMATION bar (K), with PivotBar = K - R. But we want the marker
  // to render on the PIVOT bar itself (K - R), not the confirmation bar
  // — that's where the high/low actually is. So result[K-R].highY = ph.
  function detect(dataList, leftStrength, rightStrength) {
    const n = dataList.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { highY: null, lowY: null };

    const L = leftStrength | 0;
    const R = rightStrength | 0;
    if (L < 1 || R < 1 || n < L + R + 1) return out;

    for (let k = L + R; k < n; k++) {
      const pivot = k - R;

      // High check
      const ph = dataList[pivot].high;
      let ok = true;
      for (let i = 1; i <= L; i++) {
        if (dataList[pivot - i].high > ph) { ok = false; break; }
      }
      if (ok) {
        for (let i = 1; i <= R; i++) {
          if (dataList[pivot + i].high >= ph) { ok = false; break; }
        }
      }
      if (ok) out[pivot].highY = ph;

      // Low check (mirror)
      const pl = dataList[pivot].low;
      ok = true;
      for (let i = 1; i <= L; i++) {
        if (dataList[pivot - i].low < pl) { ok = false; break; }
      }
      if (ok) {
        for (let i = 1; i <= R; i++) {
          if (dataList[pivot + i].low <= pl) { ok = false; break; }
        }
      }
      if (ok) out[pivot].lowY = pl;
    }
    return out;
  }

  // ---- Default params for fresh instances ----
  // Per-plot styling mirrors MultiCharts' indicator-settings layout:
  // each plot (PH = pivot high, PL = pivot low) carries its own type,
  // color, and width — settings dialog renders them under section
  // headers so the user can tweak each marker independently.
  const DEFAULT_PARAMS = {
    left_strength:  3,
    right_strength: 3,
    show_highs:     true,
    show_lows:      true,
    // Pivot HIGH plot
    ph_type:        'dot',     // 'dot' | 'cross' | 'bar'
    ph_color:       '#ef5350',
    ph_width:       5,
    // Pivot LOW plot
    pl_type:        'dot',
    pl_color:       '#26a69a',
    pl_width:       5,
  };

  const PLOT_TYPE_OPTIONS = [
    { value: 'dot',   label: '點狀圖' },
    { value: 'cross', label: '十字圖' },
    { value: 'bar',   label: '柱狀圖' },
  ];

  // ---- Param schema for the settings dialog ----
  // Schema entries support these `type`s (handled by indicator_settings.js):
  //   int / number — numeric input  (min, max, step optional)
  //   bool         — checkbox
  //   enum         — dropdown        (options: [{value, label}, …])
  //   color        — native colour swatch
  //   section      — non-input header row (for grouping)
  const PARAM_SCHEMA = [
    { key: 'left_strength',  label: 'LeftStrength',  type: 'int', min: 1, max: 50, default: 3 },
    { key: 'right_strength', label: 'RightStrength', type: 'int', min: 1, max: 50, default: 3 },

    { type: 'section', label: '頂部 pivot' },
    { key: 'show_highs', label: '顯示',  type: 'bool',  default: true },
    { key: 'ph_type',    label: '類型',  type: 'enum',  options: PLOT_TYPE_OPTIONS, default: 'dot' },
    { key: 'ph_color',   label: '顏色',  type: 'color', default: '#ef5350' },
    { key: 'ph_width',   label: '寬度',  type: 'int', min: 1, max: 20, default: 5 },

    { type: 'section', label: '底部 pivot' },
    { key: 'show_lows', label: '顯示',  type: 'bool',  default: true },
    { key: 'pl_type',   label: '類型',  type: 'enum',  options: PLOT_TYPE_OPTIONS, default: 'dot' },
    { key: 'pl_color',  label: '顏色',  type: 'color', default: '#26a69a' },
    { key: 'pl_width',  label: '寬度',  type: 'int', min: 1, max: 20, default: 5 },
  ];

  // ---- KLineChart indicator template (registered once at boot) ----
  // calc() runs against the chart's current dataList. In replay mode that
  // is `Replay.displayBars` (past + cursor placeholders), so no lookahead
  // — pivots only emerge as the cursor reaches their confirmation bar.
  function _buildKlineTemplate() {
    return {
      name: KLC_NAME,
      shortName: 'Swing Pivot',
      // calcParams = ONLY the params that affect calc() output.
      //   [0] L  — left strength
      //   [1] R  — right strength
      // Per-plot visual config (show_*, type, color, width) travels via
      // extendData below. Putting non-numeric values into calcParams was
      // a dead end — KLineChart's diff on calcParams is shallow / numeric,
      // so changing a colour hex string didn't trigger redraw.
      calcParams: [
        DEFAULT_PARAMS.left_strength,
        DEFAULT_PARAMS.right_strength,
      ],
      // Per-instance visual config. KLineChart passes extendData through
      // to the draw callback via `indicator.extendData`, AND
      // overrideIndicator({ extendData }) triggers a redraw without
      // re-running calc — perfect for "change colour, don't recompute".
      extendData: {
        show_highs: DEFAULT_PARAMS.show_highs,
        show_lows:  DEFAULT_PARAMS.show_lows,
        ph_type:    DEFAULT_PARAMS.ph_type,
        ph_color:   DEFAULT_PARAMS.ph_color,
        ph_width:   DEFAULT_PARAMS.ph_width,
        pl_type:    DEFAULT_PARAMS.pl_type,
        pl_color:   DEFAULT_PARAMS.pl_color,
        pl_width:   DEFAULT_PARAMS.pl_width,
      },
      // Hide KLineChart's auto-generated indicator tooltip row entirely
      // (the "Swing Pivot(3,3) PH69.47 PL n/a" line that was eating
      // vertical space at the chart top). Our own legend in
      // IndicatorManager already labels and identifies the indicator.
      styles: {
        tooltip: { showRule: 'none' },
      },
      calc(dataList, indicator) {
        const params = (indicator && indicator.calcParams) || [];
        const L = params[0] != null ? params[0] : DEFAULT_PARAMS.left_strength;
        const R = params[1] != null ? params[1] : DEFAULT_PARAMS.right_strength;
        return detect(dataList, L, R);
      },
      // ---- Custom draw — per-plot type / color / width ----
      // Mirrors MC's plot-style settings: each plot (PH / PL) draws as
      // 'dot' (filled circle), 'cross' (× stroke), or 'bar' (vertical
      // line through the pivot price). Color + width come straight from
      // calcParams[5..6] / [8..9]. Returning false tells KLineChart we
      // handled rendering — skip its default figure pass.
      draw({ ctx, kLineDataList, indicator, visibleRange, xAxis, yAxis }) {
        // Visual config lives on extendData (NOT calcParams) so colour /
        // type / visibility changes redraw without re-running calc.
        const ext = (indicator && indicator.extendData) || {};
        // Eye-icon visibility. KLineChart's `visible: false` flag is
        // honoured by the built-in figure-rendering pipeline but our
        // custom draw() bypasses figures entirely, so we read the
        // hidden flag from extendData ourselves and bail. Returning
        // false tells KLineChart we've handled this pass (no figures
        // either) — net effect: nothing drawn.
        if (ext.hidden === true) return false;
        const result = indicator && indicator.result;
        if (!Array.isArray(result) || result.length === 0) return false;
        const showHighs = ext.show_highs !== false;
        const showLows  = ext.show_lows  !== false;
        const phType  = ext.ph_type  || 'dot';
        const phColor = ext.ph_color || '#ef5350';
        const phWidth = Number(ext.ph_width) || 5;
        const plType  = ext.pl_type  || 'dot';
        const plColor = ext.pl_color || '#26a69a';
        const plWidth = Number(ext.pl_width) || 5;
        const PIXEL_OFFSET = 6;          // gap between bar wick + marker
        const from = visibleRange.realFrom != null ? visibleRange.realFrom : visibleRange.from;
        const to   = visibleRange.realTo   != null ? visibleRange.realTo   : visibleRange.to;
        ctx.save();
        for (let i = from; i < to; i++) {
          const r = result[i];
          if (!r) continue;
          if (!r.highY && !r.lowY) continue;
          // Pixel X for bar i. xAxis.convertToPixel takes a dataIndex
          // in v9; fall back to timestamp if the signature ever changes.
          let x;
          try {
            x = xAxis.convertToPixel(i);
          } catch (e) {
            const bar = kLineDataList[i];
            if (!bar) continue;
            try { x = xAxis.convertToPixel(bar.timestamp); }
            catch (er) { continue; }
          }
          if (!Number.isFinite(x)) continue;

          if (showHighs && r.highY != null) {
            const y = yAxis.convertToPixel(r.highY);
            if (Number.isFinite(y)) {
              _drawMarker(ctx, phType, x, y - PIXEL_OFFSET, phWidth, phColor);
            }
          }
          if (showLows && r.lowY != null) {
            const y = yAxis.convertToPixel(r.lowY);
            if (Number.isFinite(y)) {
              _drawMarker(ctx, plType, x, y + PIXEL_OFFSET, plWidth, plColor);
            }
          }
        }
        ctx.restore();
        return false;
      },
    };
  }

  // ---- Marker drawing helper ----
  // x, y is the marker CENTER; size controls the marker's extent
  // (radius for dot, half-side for cross, half-height for bar).
  function _drawMarker(ctx, type, x, y, size, color) {
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (type === 'cross') {
      const s = size;
      ctx.lineWidth = Math.max(1, Math.floor(size / 2));
      ctx.beginPath();
      ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
      ctx.stroke();
    } else if (type === 'bar') {
      // Centered vertical bar — thickness 2 px regardless of size,
      // total height = size * 2.
      ctx.fillRect(x - 1, y - size, 2, size * 2);
    } else {
      // 'dot' (default) — filled circle.
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- Per-instance KLineChart wiring ----
  // Each Swing Pivot instance corresponds to one KLineChart indicator on
  // the candle pane. Params are split between two channels:
  //   calcParams  → [L, R]                 affects calc() output, triggers recalc
  //   extendData  → show_*, ph/pl_*        visual config, triggers redraw only
  // This split matters: KLineChart's diff on calcParams is shallow/numeric,
  // so passing strings (colours, type names) there does NOT trigger any
  // redraw when the user picks a new colour. extendData IS detected and
  // does trigger a redraw without re-running calc — exactly what we want.
  function _paramsToCalc(p)   { return [p.left_strength, p.right_strength]; }
  function _paramsToExtend(p) {
    return {
      show_highs: !!p.show_highs,
      show_lows:  !!p.show_lows,
      ph_type:    p.ph_type,
      ph_color:   p.ph_color,
      ph_width:   p.ph_width,
      pl_type:    p.pl_type,
      pl_color:   p.pl_color,
      pl_width:   p.pl_width,
    };
  }

  // KLineChart's createIndicator returns the PANE ID, not the indicator
  // id. To identify a specific indicator instance within the pane we
  // use `name` (KLC_NAME). With our v1 design (one Swing Pivot per
  // chart) name-based identification is unambiguous; if we later add
  // multi-instance support we'll need to track KLineChart's internal
  // id via the indicator.id field at creation time.
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
      // overrideIndicator + removeIndicator both take (override, paneId)
      // in v9 — paneId is the SECOND argument, not nested in the override.
      chart.removeIndicator({ name: KLC_NAME }, paneId || 'candle_pane');
    } catch (e) { /* ignore */ }
  }

  // Unified apply — params + visibility flow through one call so the
  // full extendData object is always sent intact. Splitting into
  // applyParams / applyVisibility was tempting but fragile: KLineChart's
  // `overrideIndicator({ extendData })` merge behaviour is undocumented
  // (could be merge OR replace depending on version), and a partial
  // send risks wiping the colour / type / width config when the user
  // only toggled visibility. Always sending the full object is safe.
  //
  // Visibility lives as `ext.hidden` (boolean): draw() checks this and
  // bails before painting. Calc result is preserved either way, so
  // re-show is instant (no recompute lag, per indicator-manager-spec §2).
  function applyParams(chart, paneId, params, visible) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    const ext = _paramsToExtend(p);
    if (visible === false) ext.hidden = true;
    try {
      // CORRECT v9 signature: overrideIndicator(override, paneId).
      // paneId is the SECOND argument — passing it nested inside the
      // override object (like the buggy earlier version did) means
      // KLineChart silently ignores the call (no error, no redraw).
      chart.overrideIndicator({
        name: KLC_NAME,
        calcParams: _paramsToCalc(p),
        extendData: ext,
      }, paneId || 'candle_pane');
    } catch (e) { /* ignore */ }
  }

  // ---- Public registration object ----
  // The IndicatorManager registry stores ONE of these per indicator type.
  // Future indicators (n_wave, bos_choch, supply_demand) ship the same
  // shape so the manager can stay agnostic.
  window.SwingPivotIndicator = {
    type:          TYPE_NAME,
    name:          'Swing Pivot',
    defaultParams: { ...DEFAULT_PARAMS },
    paramSchema:   PARAM_SCHEMA,
    // KLineChart template — registered ONCE by IndicatorManager.init.
    klineTemplate: _buildKlineTemplate(),
    // Per-instance ops (called by IndicatorManager).
    add,
    remove,
    applyParams,
    // Exposed pure detector (testable in console: SwingPivotIndicator.detect(bars, 3, 3))
    detect,
  };
})();
