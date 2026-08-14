/* ============================================================================
 * micro_pivot_nwave.js — Sub-TF pivot zigzag projected on current TF
 * ============================================================================
 * Phase-2 prototype companion to n_wave.js. Solves the problem that 5-min
 * downtrends look like a single long red K with no internal pivots — even
 * though the 1-min data inside that 5-min bar has clear sub-structure
 * (small bounces / V-shape micro-reversals).
 *
 * Algorithm:
 *   1. Fetch sub-TF OHLCV for the current symbol (default 1-min).
 *   2. Run the SAME alternating-pivot detector + amplitude filter as
 *      n_wave.js on the sub-TF bars.
 *   3. For each sub-TF pivot, find the current-TF bar whose timestamp
 *      window contains the pivot's timestamp.
 *   4. Render a zigzag line connecting the pivots, using current-TF bar
 *      index for X and the pivot's actual sub-TF OHLC price for Y.
 *
 * Result: on a 5-min chart, you see micro-pivot ⋎ structure within each
 * 5-min K-bar — without changing the bars themselves.
 *
 * KEY DESIGN CHOICES:
 *   - This is a SEPARATE indicator from n_wave (VISION.md §2.4: "modular,
 *     independently-validatable modules"). It registers its own KLineChart
 *     template; you can run BOTH at once (main NWave at L=R=1 amp=93 +
 *     MicroPivot at L=R=3 amp=50) for a multi-degree view.
 *   - Sub-TF bars are fetched ONCE per (symbol, sub_tf) and cached in
 *     module state. We don't refetch on TF switch (sub-TF is independent),
 *     only on symbol switch.
 *   - calc() does NOTHING — the detection runs on sub-TF bars, not the
 *     current-TF dataList KLineChart feeds calc(). draw() reads from a
 *     module-level seq cache keyed by (symbol, sub_tf, params).
 *   - Pivot-to-current-TF mapping is a binary search by timestamp inside
 *     draw(). Cheap because the seq is small (~50-300 pivots typically).
 *
 * KNOWN PROTOTYPE LIMITATIONS:
 *   - Replay anti-spoiler not implemented: in replay mode, sub-TF pivots
 *     past the cursor MAY render. Will be tightened in a follow-up by
 *     clipping the seq at Replay.cursorTimestamp inside draw().
 *   - Mini chart integration not done: this indicator only renders on the
 *     main chart. MicroPivot for branched/mini view = separate ticket.
 *   - Sub-TF data is fetched in one shot via /api/ohlcv (no lazy pagination).
 *     For very wide chart ranges this can be a lot of bars (e.g. 5 years
 *     of 1-min = ~700k bars). Acceptable for the prototype since main NWave
 *     also lives with the full dataset.
 * ========================================================================== */

(function () {
  const TYPE_NAME = 'micro_pivot_nwave';
  const KLC_NAME  = 'MicroPivotNWave';

  // ---- Module state ----
  // sub-TF bars per (symbol, sub_tf), keyed by `${symbol}|${sub_tf}`
  const _subBarsCache = new Map();
  // in-flight fetch promises (dedupe concurrent calls)
  const _fetchInFlight = new Map();
  // computed pivot sequences per full param key
  const _seqCache = new Map();
  // dedupe scheduled refreshes — draw() fires many times per second; without
  // this, every frame between fetch start and fetch resolve would queue
  // another .then handler, causing N x overrideIndicator + N x repaint.
  const _scheduleInFlight = new Set();
  // track active instances so we can re-fetch / re-compute on symbol switch
  // entries: { chart, paneId, params, visible }
  // (visible matters because the follow-up overrideIndicator from
  // _scheduleRefresh would otherwise wipe the hidden flag the eye icon
  // just set, silently re-showing the line.)
  const _instances = [];

  function _subKey(symbol, subTf) { return `${symbol}|${subTf}`; }
  function _seqKey(symbol, p) {
    return `${symbol}|${p.sub_tf}|${p.left_strength}|${p.right_strength}|${p.min_swing_amount}|${p.swing_unit}|${p.snap_left_lookback ?? 0}`;
  }

  // ---- Detection (copy of n_wave.js detector — bit-for-bit) ----
  function detectAlternatingSequence(dataList, leftStrength, rightStrength) {
    const n = dataList.length;
    const L = leftStrength | 0;
    const R = rightStrength | 0;
    if (L < 1 || R < 1 || n < L + R + 1) return [];

    const raw = [];
    for (let k = L + R; k < n; k++) {
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
      if (okH) raw.push({ barIdx: pivot, ts: dataList[pivot].timestamp, price: ph, type: 'high' });

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
      if (okL) raw.push({ barIdx: pivot, ts: dataList[pivot].timestamp, price: pl, type: 'low' });
    }

    // collapse same-type runs
    const out = [];
    for (const p of raw) {
      if (out.length === 0) { out.push(p); continue; }
      const last = out[out.length - 1];
      if (p.type === last.type) {
        const moreExtreme = p.type === 'high'
          ? p.price > last.price
          : p.price < last.price;
        if (moreExtreme) out[out.length - 1] = p;
      } else {
        out.push(p);
      }
    }
    return out;
  }

  // ---- Snap-to-left-extreme post-process ----
  // After alternate-collapse + amplitude filter, each pivot scans LEFT
  // (up to the previous pivot's index, or `maxLookback` bars, whichever
  // is smaller) and grabs the most-extreme bar in that window.
  //
  // WHY: the standard "L ≤, R <" pivot semantics + same-type collapse
  // sometimes lands the pivot 1-3 bars to the RIGHT of the visually
  // obvious local max/min, because:
  //   1. tie-breaking on the left side allows equal-height bars to coexist;
  //   2. when two near-equal bars stand side by side, the rightmost wins
  //      the strict-right test.
  // The user repeatedly noticed: "your micro pivot has a higher high a
  // few bars to its left that wasn't marked." This pass fixes that by
  // re-anchoring each pivot to the SEGMENT's true extreme (bounded by
  // the previous pivot so we never cross-contaminate between segments).
  //
  // SAFE BY CONSTRUCTION: the new pivot stays inside its original
  // alternating segment, so type/order/alternation is preserved. We
  // re-run the same-type collapse afterwards as belt + suspenders in
  // case two adjacent pivots end up snapping to the same bar.
  function snapToLeftExtreme(seq, bars, maxLookback) {
    if (!seq.length || maxLookback <= 0) return seq;
    const out = [];
    for (let i = 0; i < seq.length; i++) {
      const p = seq[i];
      const prevBarIdx = out.length ? out[out.length - 1].barIdx : -1;
      const leftLimit = Math.max(prevBarIdx + 1, p.barIdx - maxLookback);
      let best = p;
      for (let k = leftLimit; k <= p.barIdx; k++) {
        const bar = bars[k];
        if (!bar) continue;
        if (p.type === 'high' && bar.high > best.price) {
          best = { ...p, barIdx: k, ts: bar.timestamp, price: bar.high };
        } else if (p.type === 'low' && bar.low < best.price) {
          best = { ...p, barIdx: k, ts: bar.timestamp, price: bar.low };
        }
      }
      out.push(best);
    }
    // Re-collapse adjacent same-type (rare but possible if two pivots
    // snap to the same bar — e.g. a wick that's both segment high and
    // next segment low isn't possible in our model, but guard anyway).
    const collapsed = [];
    for (const p of out) {
      if (collapsed.length === 0) { collapsed.push(p); continue; }
      const last = collapsed[collapsed.length - 1];
      if (p.type === last.type) {
        const more = p.type === 'high' ? p.price > last.price : p.price < last.price;
        if (more) collapsed[collapsed.length - 1] = p;
      } else {
        collapsed.push(p);
      }
    }
    return collapsed;
  }

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
      if (leg >= th) { out.push(p); continue; }
      out.pop();
      if (out.length === 0) {
        const moreExtreme = (p.type === last.type)
          ? (p.type === 'high'
              ? (p.price > last.price ? p : last)
              : (p.price < last.price ? p : last))
          : p;
        out.push(moreExtreme);
        continue;
      }
      const prev = out[out.length - 1];
      if (prev.type === p.type) {
        const moreExtreme = p.type === 'high'
          ? p.price > prev.price
          : p.price < prev.price;
        if (moreExtreme) out[out.length - 1] = p;
      } else {
        out.push(p);
      }
    }
    return out;
  }

  // ---- Sub-TF data fetch ----
  // Bound the fetch to the CURRENT chart's visible time window so we don't
  // ship the full multi-year 1-min history on every add (which was ~100s of
  // MB of JSON and triggered a 5-10s lag before the line could draw).
  // Trade-off: if the user pans far left into uncached history, the
  // micro-pivot zigzag will end at the original fetch's left edge. A real
  // fix would hook into loadMore and incrementally extend the cache.
  async function _ensureSubBars(symbol, subTf) {
    if (!symbol || !subTf) return [];
    const key = _subKey(symbol, subTf);
    if (_subBarsCache.has(key)) return _subBarsCache.get(key);
    if (_fetchInFlight.has(key)) return _fetchInFlight.get(key);

    const p = (async () => {
      try {
        let rangeQ = '';
        const cur = window.App && window.App.currentBars;
        if (Array.isArray(cur) && cur.length > 0) {
          const startMs = cur[0].timestamp;
          const endMs   = cur[cur.length - 1].timestamp + 24 * 3600 * 1000;
          rangeQ = `&start=${encodeURIComponent(new Date(startMs).toISOString())}`
                 + `&end=${encodeURIComponent(new Date(endMs).toISOString())}`;
        }
        const url = `/api/ohlcv?tf=${encodeURIComponent(subTf)}&symbol=${encodeURIComponent(symbol)}${rangeQ}`;
        const t0 = performance.now();
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error('http ' + r.status);
        const j = await r.json();
        const bars = Array.isArray(j) ? j : (j.bars || []);
        console.log(`[MicroPivotNWave] fetched ${bars.length} ${subTf}-min bars for ${symbol} in ${Math.round(performance.now() - t0)}ms`);
        _subBarsCache.set(key, bars);
        return bars;
      } catch (err) {
        console.warn('[MicroPivotNWave] sub-bars fetch failed', err);
        return [];
      } finally {
        _fetchInFlight.delete(key);
      }
    })();
    _fetchInFlight.set(key, p);
    return p;
  }

  function _recomputeAndCache(symbol, params) {
    const subTf = params.sub_tf;
    const bars = _subBarsCache.get(_subKey(symbol, subTf)) || [];
    if (!bars.length) return [];
    let seq = detectAlternatingSequence(bars, params.left_strength, params.right_strength);
    seq = applyAmplitudeFilter(seq, Number(params.min_swing_amount) || 0, params.swing_unit);
    const lookback = Number(params.snap_left_lookback);
    if (lookback > 0) seq = snapToLeftExtreme(seq, bars, lookback | 0);
    // Strip barIdx (only meaningful in sub-TF context); keep ts + price + type
    const out = seq.map(p => ({ ts: p.ts, price: p.price, type: p.type }));
    _seqCache.set(_seqKey(symbol, params), out);
    return out;
  }

  function _scheduleRefresh(chart, paneId, params) {
    if (!chart) return;
    const symbol = (window.App && window.App.currentSymbol) || '';
    if (!symbol) return;
    const scheduleKey = `${chart.__mpKey || ''}|${paneId}|${_seqKey(symbol, params)}`;
    if (_scheduleInFlight.has(scheduleKey)) return;
    _scheduleInFlight.add(scheduleKey);
    _ensureSubBars(symbol, params.sub_tf).then(bars => {
      try {
        if (!bars.length) return;
        // RACE GUARD: if the user removed the indicator while the fetch was
        // in flight, don't push extendData back — that would silently
        // resurrect the (already-removed) indicator inside KLineChart's
        // internal map.
        const inst = _instances.find(x => x.chart === chart && x.paneId === paneId);
        if (!inst) return;
        _recomputeAndCache(symbol, params);
        const ext = _paramsToExtend(params);
        ext.symbol = symbol;
        ext.sub_tf = params.sub_tf;
        ext._tick = Date.now();
        // Preserve the eye-icon's hidden state across this follow-up push.
        // Without this, toggling hide right after fetch resolves would
        // bounce the line back on.
        if (inst.visible === false) ext.hidden = true;
        try {
          chart.overrideIndicator({ name: KLC_NAME, extendData: ext }, paneId || 'candle_pane');
        } catch (e) { /* ignore */ }
      } finally {
        _scheduleInFlight.delete(scheduleKey);
      }
    });
  }

  // ---- Defaults / schema ----
  const DEFAULT_PARAMS = {
    sub_tf:               '1',        // backend TF string ('1' = 1 min)
    left_strength:        3,
    right_strength:       3,
    min_swing_amount:     50,         // TXF1 sweet-spot per analyze_downtrend_density.py
    swing_unit:           'absolute',
    // Snap each detected pivot to the most-extreme bar in its segment
    // (capped by this many sub-TF bars). Fixes the MC tie-right bias
    // where the indicator lands 1-3 bars past the visually-obvious high.
    // Set to 0 to disable.
    snap_left_lookback:   10,
    line_color:           '#aa5cf2',  // purple, distinct from main NWave (yellow)
    line_width:           1,
    line_style:           'solid',
    show:                 true,
  };

  const SUB_TF_OPTIONS = [
    { value: '1',  label: '1 min'  },
    { value: '3',  label: '3 min'  },
    { value: '5',  label: '5 min'  },
    { value: '15', label: '15 min' },
    { value: '1h', label: '1 hour' },
  ];

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
    { type: 'section', label: '子 TF 資料源' },
    { key: 'sub_tf',         label: '子時段',      type: 'enum', options: SUB_TF_OPTIONS, default: '1' },

    { type: 'section', label: 'Pivot 偵測' },
    { key: 'left_strength',  label: 'LeftStrength',  type: 'int', min: 1, max: 50, default: 3 },
    { key: 'right_strength', label: 'RightStrength', type: 'int', min: 1, max: 50, default: 3 },

    { type: 'section', label: '濾波（過濾小波動）' },
    { key: 'min_swing_amount', label: '最小擺動',  type: 'number', min: 0, default: 50 },
    { key: 'swing_unit',       label: '單位',      type: 'enum', options: SWING_UNIT_OPTIONS, default: 'absolute' },

    { type: 'section', label: '吸附對齊（修正左偏）' },
    { key: 'snap_left_lookback', label: '左側回看（0=關）', type: 'int', min: 0, max: 50, default: 10 },

    { type: 'section', label: 'N 字連線' },
    { key: 'show',       label: '顯示',  type: 'bool',  default: true },
    { key: 'line_color', label: '顏色',  type: 'color', default: '#aa5cf2' },
    { key: 'line_width', label: '寬度',  type: 'int', min: 1, max: 10, default: 1 },
    { key: 'line_style', label: '樣式',  type: 'enum', options: LINE_STYLE_OPTIONS, default: 'solid' },
  ];

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
      shortName: 'Micro N',
      calcParams: [
        DEFAULT_PARAMS.sub_tf,
        DEFAULT_PARAMS.left_strength,
        DEFAULT_PARAMS.right_strength,
        DEFAULT_PARAMS.min_swing_amount,
        DEFAULT_PARAMS.swing_unit,
        DEFAULT_PARAMS.snap_left_lookback,
      ],
      extendData: {
        sub_tf:             DEFAULT_PARAMS.sub_tf,
        left_strength:      DEFAULT_PARAMS.left_strength,
        right_strength:     DEFAULT_PARAMS.right_strength,
        min_swing_amount:   DEFAULT_PARAMS.min_swing_amount,
        swing_unit:         DEFAULT_PARAMS.swing_unit,
        snap_left_lookback: DEFAULT_PARAMS.snap_left_lookback,
        line_color:         DEFAULT_PARAMS.line_color,
        line_width:         DEFAULT_PARAMS.line_width,
        line_style:         DEFAULT_PARAMS.line_style,
        show:               DEFAULT_PARAMS.show,
      },
      styles: {
        tooltip: { showRule: 'none' },
      },
      // calc() intentionally does nothing — the detection runs on sub-TF
      // bars in _recomputeAndCache(), not on the current-TF dataList that
      // KLineChart hands to calc(). KLineChart still requires calc() to
      // return an array same length as dataList.
      calc(dataList) {
        return new Array(dataList.length).fill(null);
      },
      draw({ ctx, kLineDataList, indicator, visibleRange, xAxis, yAxis }) {
        const ext = (indicator && indicator.extendData) || {};
        if (ext.hidden === true || ext.show === false) return false;
        if (!kLineDataList || kLineDataList.length === 0) return false;

        const symbol = ext.symbol || (window.App && window.App.currentSymbol);
        if (!symbol) return false;

        // Reconstruct the FULL param set from ext — including visual keys
        // (line_color/style/width/show). Without this, the lazy-bootstrap
        // call to _scheduleRefresh below would build extendData from
        // DEFAULT_PARAMS via _paramsToExtend, then overrideIndicator would
        // wipe the user's saved colour with the purple default whenever
        // the lazy-bootstrap raced ahead of the app:symbolChanged
        // handler's proper refresh on boot.
        const params = {
          sub_tf:             ext.sub_tf             || DEFAULT_PARAMS.sub_tf,
          left_strength:      ext.left_strength      ?? DEFAULT_PARAMS.left_strength,
          right_strength:     ext.right_strength     ?? DEFAULT_PARAMS.right_strength,
          min_swing_amount:   ext.min_swing_amount   ?? DEFAULT_PARAMS.min_swing_amount,
          swing_unit:         ext.swing_unit         || DEFAULT_PARAMS.swing_unit,
          snap_left_lookback: ext.snap_left_lookback ?? DEFAULT_PARAMS.snap_left_lookback,
          line_color:         ext.line_color         || DEFAULT_PARAMS.line_color,
          line_width:         ext.line_width         ?? DEFAULT_PARAMS.line_width,
          line_style:         ext.line_style         || DEFAULT_PARAMS.line_style,
          show:               ext.show !== false,
        };

        const key = _seqKey(symbol, params);
        let seq = _seqCache.get(key);
        if (!seq) {
          // Lazy bootstrap: cache miss → schedule fetch + recompute.
          // Use App.chart + 'candle_pane' for the main-chart instance.
          // Multi-instance / mini-chart not supported in the prototype.
          const chart = window.App && window.App.chart;
          if (chart) _scheduleRefresh(chart, 'candle_pane', { ...DEFAULT_PARAMS, ...params });
          return false;
        }
        if (seq.length < 2) return false;

        const color = ext.line_color || DEFAULT_PARAMS.line_color;
        const width = Number(ext.line_width) || 1;
        const style = ext.line_style || 'solid';

        const from = visibleRange.realFrom != null ? visibleRange.realFrom : visibleRange.from;
        const to   = visibleRange.realTo   != null ? visibleRange.realTo   : visibleRange.to;

        // Build timestamps lookup once
        const n = kLineDataList.length;
        const tsList = new Array(n);
        for (let i = 0; i < n; i++) tsList[i] = kLineDataList[i].timestamp;
        // Estimate current TF window size for off-end clamp
        const tfMs = n >= 2 ? (tsList[1] - tsList[0]) : 60_000;

        // Pass 1a: project each sub-TF pivot onto its enclosing current-TF
        // bar (binary search by timestamp).
        const projected = [];
        for (const p of seq) {
          let lo = 0, hi = n - 1, idx = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (tsList[mid] <= p.ts) { idx = mid; lo = mid + 1; }
            else hi = mid - 1;
          }
          if (idx < 0) continue;
          // Reject pivots past the last bar's window (relevant when sub-TF
          // data is fresher than current TF — e.g. an unaggregated 1-min
          // sitting past the last 5-min bar's end).
          if (idx === n - 1 && p.ts >= tsList[idx] + tfMs) continue;
          projected.push({ idx, type: p.type, price: p.price });
        }

        // Pass 1b: walk the projected list and reduce to at-most-one
        // pivot per current-TF bar.
        //
        // Collision rule (when two pivots fall in the same current-TF bar):
        //   The two are necessarily opposite types because the input
        //   sub-TF seq is strict-alternating. Decide which to keep by
        //   asking: "which one would SURVIVE same-type collapse against
        //   its same-type neighbour (prev in pts or next in projected)?"
        //
        //   Concretely: for each candidate C with neighbour N of the SAME
        //   type, C survives iff C.price is at least as extreme as N.price
        //   (>= for highs, <= for lows). If the neighbour is a different
        //   type or absent, C trivially survives that side.
        //
        //   The candidate that survives BOTH sides is the structural
        //   pivot at this bar; the other would be absorbed by collapse
        //   anyway. If both survive (rare), the chronologically-first
        //   wins. If neither survives, this bar's pair is a transient
        //   wiggle the seq would discard either way — pick first as a
        //   tiebreaker so visualisation stays deterministic.
        //
        // Why this rule: the previous "always drop second" rule erased
        // bars where the SECOND pivot was the structurally significant
        // one (e.g. a 5-min bar that closed at its high, with a small
        // intra-bar low coming first). The survival test correctly
        // identifies whichever pivot is the bar's "real" extreme in
        // the surrounding zigzag context.
        const survivesVs = (cand, neighbour) => {
          if (!neighbour || neighbour.type !== cand.type) return true;
          return cand.type === 'high'
            ? cand.price >= neighbour.price
            : cand.price <= neighbour.price;
        };

        const pts = [];
        for (let i = 0; i < projected.length; i++) {
          const cur = projected[i];
          const last = pts.length > 0 ? pts[pts.length - 1] : null;

          // SAME-BAR COLLISION with previously kept pivot.
          if (last && last.idx === cur.idx && last.type !== cur.type) {
            const prev = pts.length > 1 ? pts[pts.length - 2] : null;
            const next = i + 1 < projected.length ? projected[i + 1] : null;
            const fSurvives = survivesVs(last, prev) && survivesVs(last, next);
            const sSurvives = survivesVs(cur,  prev) && survivesVs(cur,  next);
            let winner;
            if (fSurvives && !sSurvives)      winner = last;
            else if (sSurvives && !fSurvives) winner = cur;
            else                               winner = last;     // tie → keep first
            pts.pop();
            // Same-type collapse with prev (winner may collide with prev too)
            if (prev && prev.type === winner.type) {
              const more = winner.type === 'high' ? winner.price > prev.price : winner.price < prev.price;
              if (more) pts[pts.length - 1] = winner;
              // else: winner absorbed, prev stays
            } else {
              pts.push(winner);
            }
            continue;
          }

          // SAME-TYPE COLLAPSE with previously kept pivot on a DIFFERENT bar.
          if (last && last.type === cur.type) {
            const more = cur.type === 'high' ? cur.price > last.price : cur.price < last.price;
            if (more) pts[pts.length - 1] = cur;
            continue;
          }

          pts.push(cur);
        }

        // Pass 2: stroke with visible-range cull.
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        _applyLineDash(ctx, style, width);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        let started = false;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          if (p.idx < from - 2) continue;
          if (p.idx > to + 2) {
            if (!started) continue;
            break;
          }
          const x = xAxis.convertToPixel(p.idx);
          const y = yAxis.convertToPixel(p.price);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (!started) { ctx.moveTo(x, y); started = true; }
          else { ctx.lineTo(x, y); }
        }
        if (started) ctx.stroke();
        ctx.restore();
        ctx.setLineDash([]);
        return false;
      },
    };
  }

  function _paramsToCalc(p) {
    return [p.sub_tf, p.left_strength, p.right_strength, p.min_swing_amount, p.swing_unit, p.snap_left_lookback];
  }
  function _paramsToExtend(p) {
    return {
      sub_tf:             p.sub_tf,
      left_strength:      p.left_strength,
      right_strength:     p.right_strength,
      min_swing_amount:   p.min_swing_amount,
      swing_unit:         p.swing_unit,
      snap_left_lookback: p.snap_left_lookback,
      line_color:         p.line_color,
      line_width:         p.line_width,
      line_style:         p.line_style,
      show:               !!p.show,
    };
  }

  function add(chart, params) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    const symbol = (window.App && window.App.currentSymbol) || '';
    const ext = _paramsToExtend(p);
    ext.symbol = symbol;
    const paneId = chart.createIndicator({
      name: KLC_NAME,
      calcParams: _paramsToCalc(p),
      extendData: ext,
    }, true, { id: 'candle_pane' });
    _instances.push({ chart, paneId, params: { ...p }, visible: true });
    _scheduleRefresh(chart, paneId, p);
    return paneId;
  }

  function remove(chart, paneId) {
    const idx = _instances.findIndex(x => x.chart === chart && x.paneId === paneId);
    if (idx >= 0) {
      // Drop the cached seq for this instance's params so a stale draw()
      // (KLineChart's internal paint cache) can't quietly keep showing
      // the line if removeIndicator failed to flush immediately.
      const inst = _instances[idx];
      const symbol = (window.App && window.App.currentSymbol) || '';
      if (symbol) _seqCache.delete(_seqKey(symbol, inst.params));
      _instances.splice(idx, 1);
    }
    // Belt + suspenders: hide via extendData first, then actually remove.
    // If KLineChart's removeIndicator races against a queued repaint, at
    // least the next frame draws nothing because ext.show === false.
    try {
      chart.overrideIndicator({ name: KLC_NAME, extendData: { show: false, hidden: true } }, paneId || 'candle_pane');
    } catch (e) { /* ignore */ }
    try {
      chart.removeIndicator({ name: KLC_NAME }, paneId || 'candle_pane');
    } catch (e) { /* ignore */ }
  }

  function applyParams(chart, paneId, params, visible) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    const inst = _instances.find(x => x.chart === chart && x.paneId === paneId);
    if (inst) {
      inst.params = { ...p };
      inst.visible = visible !== false;
    }
    const symbol = (window.App && window.App.currentSymbol) || '';
    const ext = _paramsToExtend(p);
    ext.symbol = symbol;
    if (visible === false) ext.hidden = true;
    try {
      chart.overrideIndicator({
        name: KLC_NAME,
        calcParams: _paramsToCalc(p),
        extendData: ext,
      }, paneId || 'candle_pane');
    } catch (e) { /* ignore */ }
    _scheduleRefresh(chart, paneId, p);
  }

  // ---- Symbol-change hook ----
  // App.js dispatches 'app:symbolChanged' after App.currentSymbol is updated.
  // We invalidate the seq cache (sub-TF bars cache is per-symbol so it's
  // safe to keep — different symbol = different cache key) and refresh
  // every active instance.
  window.addEventListener('app:symbolChanged', () => {
    _seqCache.clear();
    for (const inst of _instances) {
      _scheduleRefresh(inst.chart, inst.paneId, inst.params);
    }
  });

  // ---- Public registration ----
  window.MicroPivotNWaveIndicator = {
    type:          TYPE_NAME,
    name:          'Micro Pivot N Wave',
    defaultParams: { ...DEFAULT_PARAMS },
    paramSchema:   PARAM_SCHEMA,
    klineTemplate: _buildKlineTemplate(),
    add,
    remove,
    applyParams,
    // Exposed pure functions for testing / future structure-classifier use:
    detectAlternatingSequence,
    applyAmplitudeFilter,
  };
})();
