/* ============================================================================
 * n_wave.js — N-wave zigzag connector (Phase 2 prototype)
 * ============================================================================
 * Per VISION.md §3 Phase 2: consume the swing-pivot series and visualise
 * Wister's "N 字" structure. This first prototype is intentionally simple:
 * draw a polyline connecting every confirmed swing pivot in chronological
 * order — a classic zigzag. The user evaluates the visual fit on real
 * charts before we layer on the actual N-up / N-down / CHoCh
 * classification (which needs A→B→C→D 4-point confirmation per Wister's
 * 上課概念 §2-1: C > A and D > B for a valid N-up).
 *
 * SAME detection algorithm as swing_pivot.js (bit-for-bit) so the user
 * can run both indicators side-by-side with the SAME L/R and see that
 * the line endpoints land exactly on the swing-pivot dots.
 *
 * REPLAY SAFETY: same as swing_pivot — calc runs on KLineChart's current
 * dataList, which in replay mode is Replay.displayBars (truncated at
 * cursor). The zigzag only extends to confirmed pivots up to the cursor
 * — never reveals a future pivot.
 *
 * DUAL-FLAG bars (the 245 single-wide-bar cases in TXF1 where the bar
 * is BOTH swing high AND swing low): both entries land in the sequence
 * at the same barIdx; the draw loop draws a near-zero-length vertical
 * line segment in that case. Visually weird but data-faithful — we'll
 * decide on a smoothing rule once the user sees how often it actually
 * shows up in real practice.
 * ========================================================================== */

(function () {
  const TYPE_NAME = 'n_wave';
  const KLC_NAME  = 'NWave';

  // ---- Pure detector — strict-alternating high ↔ low zigzag ----
  // Per the user's spec:
  //   "在有 n 字上漲的時候一定是將 low pivot 連線下一個 high pivot
  //    並且 high pivot 的下一個一定要找 low pivot 反之也是如此"
  // i.e. the zigzag MUST alternate types. Connecting two consecutive
  // highs (or two lows) directly is illegal — that would form a flat
  // top / flat bottom which isn't a valid N-wave leg.
  //
  // When the raw pivot scan yields two consecutive same-type pivots
  // (e.g. two highs in a row before the next low confirms), the
  // collapse keeps the MORE EXTREME one (the higher high or the lower
  // low) and drops the other. This is the standard zigzag-on-pivots
  // convention and matches what the user drew on the screenshot
  // (every line goes diagonally between a red dot and a blue dot).
  //
  // Dual-flag bars (245 cases on TXF1 5-min where one bar is both
  // swing high AND swing low — see swing_pivot.py docstring) emit
  // BOTH into the raw stream; the collapse then handles them like
  // any other same-type/different-type sequence. End result: dual-
  // flag bars naturally contribute the type that alternates from
  // the previous accepted pivot.
  function detectAlternatingSequence(dataList, leftStrength, rightStrength) {
    const n = dataList.length;
    const L = leftStrength | 0;
    const R = rightStrength | 0;
    if (L < 1 || R < 1 || n < L + R + 1) return [];

    // Step 1 — raw chronological pivot list (same MC semantics as
    // swing_pivot.js: left `<=` allow ties, right `<` strict).
    //
    // REPLAY SAFETY: replay mode appends "placeholder" bars past the
    // cursor (per replay.js makeFutureSlots — they carry a synthetic
    // flat OHLC at fillPrice). If the walker hits one of those bars
    // as part of a pivot's right-side check, the placeholder's flat
    // OHLC trivially satisfies the strict `<` test → pivot would
    // confirm during replay but NOT in full mode. That's lookahead.
    // Stop the walker the moment we hit the first placeholder so the
    // R-bar right-side window only contains real bars.
    const raw = [];
    for (let k = L + R; k < n; k++) {
      if (dataList[k] && dataList[k]._placeholder) break;
      const pivot = k - R;

      const ph = dataList[pivot].high;
      let okH = true;
      for (let i = 1; i <= L; i++) {
        if (dataList[pivot - i].high > ph) { okH = false; break; }
      }
      if (okH) {
        for (let i = 1; i <= R; i++) {
          if (dataList[pivot + i].high >= ph) { okH = false; break; }
        }
      }
      if (okH) raw.push({ barIdx: pivot, price: ph, type: 'high' });

      const pl = dataList[pivot].low;
      let okL = true;
      for (let i = 1; i <= L; i++) {
        if (dataList[pivot - i].low < pl) { okL = false; break; }
      }
      if (okL) {
        for (let i = 1; i <= R; i++) {
          if (dataList[pivot + i].low <= pl) { okL = false; break; }
        }
      }
      if (okL) raw.push({ barIdx: pivot, price: pl, type: 'low' });
    }

    // Step 2 — collapse same-type runs to the more extreme entry.
    // out[] grows by at most one per raw item; when same-type fires
    // we replace out[-1] in place (the higher high / lower low wins).
    const out = [];
    for (const p of raw) {
      if (out.length === 0) { out.push(p); continue; }
      const last = out[out.length - 1];
      if (p.type === last.type) {
        const moreExtreme = p.type === 'high'
          ? p.price > last.price
          : p.price < last.price;
        if (moreExtreme) out[out.length - 1] = p;
        // else: skip — the previous one wins
      } else {
        out.push(p);
      }
    }
    return out;
  }

  // ---- Amplitude filter — drop sub-wiggles below a min threshold ----
  // After collapse, walk pivots forward. When a leg p[i-1]→p[i] is
  // below threshold, the wiggle is structurally insignificant and we
  // fold it into the surrounding move:
  //   drop p[i-1]; if the new tail (p[i-2]) is the same type as p[i],
  //   keep the more extreme one (i.e. apply the collapse rule again).
  // Threshold interpretation:
  //   unit='absolute' → raw price-point delta (TXF1 5m: ~100)
  //   unit='pct'      → percent of the pivot price (gold 5m: 0.15%)
  //   amount = 0      → no filter (preserve every raw alternating point)
  function applyAmplitudeFilter(seq, amount, unit) {
    if (!amount || amount <= 0) return seq;
    const thresholdAt = (price) => unit === 'pct'
      ? (price * amount / 100)
      : amount;

    const out = [];
    for (const p of seq) {
      if (out.length === 0) { out.push(p); continue; }
      const last = out[out.length - 1];
      const leg = Math.abs(p.price - last.price);
      const th  = thresholdAt(Math.max(last.price, p.price));
      if (leg >= th) {
        out.push(p);
        continue;
      }
      // Sub-threshold wiggle. Drop `last`, re-evaluate against the
      // pivot BEFORE it (if any).
      out.pop();
      if (out.length === 0) {
        // Nothing to compare against — just take the more extreme of
        // the pair so we still seed alternation downstream.
        const moreExtreme = (p.type === last.type)
          ? (p.type === 'high'
              ? (p.price > last.price ? p : last)
              : (p.price < last.price ? p : last))
          : p;       // different types → favour newer
        out.push(moreExtreme);
        continue;
      }
      const prev = out[out.length - 1];
      if (prev.type === p.type) {
        // Two same-type entries now adjacent in `out` (after popping
        // `last`). Keep the more extreme.
        const moreExtreme = p.type === 'high'
          ? p.price > prev.price
          : p.price < prev.price;
        if (moreExtreme) out[out.length - 1] = p;
      } else {
        // prev (deep) and p are opposite types → safe to keep p as
        // the new alternating tail.
        out.push(p);
      }
    }
    return out;
  }

  // ---- Defaults / schema ----
  const DEFAULT_PARAMS = {
    left_strength:    3,
    right_strength:   3,
    // Minimum swing amplitude — filters out inner wiggles that don't
    // exceed the threshold (TXF1 5m: ~100 points, gold 5m: ~6, NQ 5m: ~80).
    // 0 = no filter (keep every alternating raw pivot).
    // Mode controls unit interpretation: 'absolute' (raw price points) or
    // 'pct' (percent × the pivot's price, so threshold scales with price).
    min_swing_amount: 0,
    swing_unit:       'absolute',   // 'absolute' | 'pct'
    line_color:       '#ffeb3b',
    line_width:       1,
    line_style:       'solid',
    show:             true,
  };

  const LINE_STYLE_OPTIONS = [
    { value: 'solid',  label: '實線' },
    { value: 'dashed', label: '虛線' },
    { value: 'dotted', label: '點線' },
  ];

  const SWING_UNIT_OPTIONS = [
    { value: 'absolute', label: '價格點' },
    { value: 'pct',      label: '百分比 %' },
  ];

  const PARAM_SCHEMA = [
    { key: 'left_strength',  label: 'LeftStrength',  type: 'int', min: 1, max: 50, default: 3 },
    { key: 'right_strength', label: 'RightStrength', type: 'int', min: 1, max: 50, default: 3 },

    { type: 'section', label: '濾波（過濾小波動）' },
    { key: 'min_swing_amount', label: '最小擺動',  type: 'number', min: 0, default: 0 },
    { key: 'swing_unit',       label: '單位',      type: 'enum', options: SWING_UNIT_OPTIONS, default: 'absolute' },

    { type: 'section', label: 'N 字連線' },
    { key: 'show',       label: '顯示',  type: 'bool',  default: true },
    { key: 'line_color', label: '顏色',  type: 'color', default: '#ffeb3b' },
    { key: 'line_width', label: '寬度',  type: 'int', min: 1, max: 10, default: 1 },
    { key: 'line_style', label: '樣式',  type: 'enum', options: LINE_STYLE_OPTIONS, default: 'solid' },
  ];

  // ---- Apply line style to canvas context ----
  function _applyLineDash(ctx, style, width) {
    if (style === 'dashed') {
      ctx.setLineDash([width * 4, width * 3]);
    } else if (style === 'dotted') {
      ctx.setLineDash([width, width * 2]);
    } else {
      ctx.setLineDash([]);
    }
  }

  // ---- KLineChart template ----
  function _buildKlineTemplate() {
    return {
      name: KLC_NAME,
      shortName: 'N Wave',
      // calcParams = ANY param that affects calc() output (drives recalc).
      // We pack [L, R, min_swing_amount, swing_unit] here — amplitude
      // filter changes the OUTPUT sequence, so it belongs with calc
      // params, NOT with the visual extendData. swing_unit is a string
      // but it's only TWO discrete values ('absolute' / 'pct'); KLineChart's
      // shallow diff still picks up the change.
      calcParams: [
        DEFAULT_PARAMS.left_strength,
        DEFAULT_PARAMS.right_strength,
        DEFAULT_PARAMS.min_swing_amount,
        DEFAULT_PARAMS.swing_unit,
      ],
      extendData: {
        line_color: DEFAULT_PARAMS.line_color,
        line_width: DEFAULT_PARAMS.line_width,
        line_style: DEFAULT_PARAMS.line_style,
        show:       DEFAULT_PARAMS.show,
      },
      styles: {
        tooltip: { showRule: 'none' },     // suppress KLineChart's auto info row
      },
      // calc() returns the sequence on the FIRST bar slot (index 0) only.
      // We don't need per-bar results — the draw callback iterates the
      // shared sequence directly. Storing it on result[0] is a quirky
      // but cheap way to attach the array to the indicator object.
      calc(dataList, indicator) {
        const params = (indicator && indicator.calcParams) || [];
        const L      = params[0] != null ? params[0] : DEFAULT_PARAMS.left_strength;
        const R      = params[1] != null ? params[1] : DEFAULT_PARAMS.right_strength;
        const amount = params[2] != null ? params[2] : DEFAULT_PARAMS.min_swing_amount;
        const unit   = params[3] || DEFAULT_PARAMS.swing_unit;
        let seq = detectAlternatingSequence(dataList, L, R);
        seq = applyAmplitudeFilter(seq, Number(amount) || 0, unit);
        // KLineChart expects an array same length as dataList. We only need
        // ONE slot to attach the sequence; the rest stay null and the draw
        // callback ignores them entirely.
        const out = new Array(dataList.length).fill(null);
        if (out.length > 0) out[0] = { seq };
        return out;
      },
      draw({ ctx, kLineDataList, indicator, visibleRange, xAxis, yAxis }) {
        const ext = (indicator && indicator.extendData) || {};
        if (ext.hidden === true || ext.show === false) return false;
        const result = indicator && indicator.result;
        if (!Array.isArray(result) || result.length === 0) return false;
        const seq = (result[0] && result[0].seq) || [];
        if (seq.length < 2) return false;

        const color = ext.line_color || '#ffeb3b';
        const width = Number(ext.line_width) || 1;
        const style = ext.line_style || 'solid';
        const from = visibleRange.realFrom != null ? visibleRange.realFrom : visibleRange.from;
        const to   = visibleRange.realTo   != null ? visibleRange.realTo   : visibleRange.to;

        // Convert visible-range bar indices to xAxis pixel — done inline to
        // avoid an extra fn call per segment.
        const xAt = (idx) => {
          try { return xAxis.convertToPixel(idx); }
          catch (e) {
            const bar = kLineDataList[idx];
            if (!bar) return NaN;
            try { return xAxis.convertToPixel(bar.timestamp); } catch (er) { return NaN; }
          }
        };

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        _applyLineDash(ctx, style, width);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Clip the polyline to the visible range plus a small overlap on
        // each side, so segments straddling the viewport edge still render.
        // Walking the WHOLE seq is fine — it's small (≤ ~35k entries in
        // the worst case on TXF1 5-min L=R=3, which paints in ~5ms).
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < seq.length; i++) {
          const p = seq[i];
          if (p.barIdx < from - 1 && i + 1 < seq.length && seq[i + 1].barIdx < from - 1) continue;
          if (p.barIdx > to + 1) break;
          const x = xAt(p.barIdx);
          const y = yAxis.convertToPixel(p.price);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (!started) { ctx.moveTo(x, y); started = true; }
          else          { ctx.lineTo(x, y); }
        }
        if (started) ctx.stroke();
        ctx.restore();
        ctx.setLineDash([]);     // reset for downstream draws
        return false;
      },
    };
  }

  // ---- Param packing for KLineChart override calls ----
  function _paramsToCalc(p) {
    return [
      p.left_strength,
      p.right_strength,
      p.min_swing_amount,
      p.swing_unit,
    ];
  }
  function _paramsToExtend(p) {
    return {
      line_color: p.line_color,
      line_width: p.line_width,
      line_style: p.line_style,
      show:       !!p.show,
    };
  }

  // ---- Per-instance ops ----
  // MULTI-INSTANCE: KLineChart keys indicators by `name` WITHIN a pane, so two
  // instances sharing KLC_NAME on 'candle_pane' collapse into one (the second
  // createIndicator replaces the first → only one N-wave line shows). To stack
  // 2–3 N-waves with different params we register a PER-INSTANCE template clone
  // under a unique name derived from the manager's instance id, and return that
  // name as the opaque handle the manager stores as `kline_id` (then passes back
  // to remove / applyParams). The pane is always 'candle_pane' for these overlay
  // indicators. instanceId is optional so a bare add() (no manager) still works.
  const _registeredNames = new Set();

  function _klineNameFor(instanceId) {
    return instanceId ? `${KLC_NAME}__${instanceId}` : KLC_NAME;
  }

  function _ensureTemplate(klineName) {
    if (_registeredNames.has(klineName)) return;
    const tpl = _buildKlineTemplate();
    tpl.name = klineName;          // unique per instance → its own pane slot
    try { klinecharts.registerIndicator(tpl); } catch (e) { /* re-register overwrites, fine */ }
    _registeredNames.add(klineName);
  }

  function add(chart, params, instanceId) {
    const klineName = _klineNameFor(instanceId);
    _ensureTemplate(klineName);
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    chart.createIndicator({
      name: klineName,
      calcParams: _paramsToCalc(p),
      extendData: _paramsToExtend(p),
    }, true, { id: 'candle_pane' });
    return klineName;              // handle stored by the manager as kline_id
  }

  function remove(chart, handle) {
    try {
      chart.removeIndicator({ name: handle || KLC_NAME }, 'candle_pane');
    } catch (e) { /* ignore */ }
  }

  function applyParams(chart, handle, params, visible) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    const ext = _paramsToExtend(p);
    if (visible === false) ext.hidden = true;
    try {
      chart.overrideIndicator({
        name: handle || KLC_NAME,
        calcParams: _paramsToCalc(p),
        extendData: ext,
      }, 'candle_pane');
    } catch (e) { /* ignore */ }
  }

  // ---- Public registration ----
  window.NWaveIndicator = {
    type:          TYPE_NAME,
    name:          'N Wave',
    defaultParams: { ...DEFAULT_PARAMS },
    paramSchema:   PARAM_SCHEMA,
    klineTemplate: _buildKlineTemplate(),
    add,
    remove,
    applyParams,
    // Exposed pure functions for console / structure-classifier consumers
    // (BOSChoChDetector / MicroPivotNWave / future Phase 2 classifier):
    //   NWaveIndicator.detectAlternatingSequence(bars, L, R)
    //     → [{barIdx, price, type}, …]  (strict high↔low alternation)
    //   NWaveIndicator.applyAmplitudeFilter(seq, amount, unit)
    //     → filtered seq  (drops sub-threshold legs per §amplitude logic)
    detectAlternatingSequence,
    applyAmplitudeFilter,
  };
})();
