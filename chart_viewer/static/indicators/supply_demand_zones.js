/* ============================================================================
 * supply_demand_zones.js — Supply / Demand zones + 極限位置 (Phase 4 main)
 * ============================================================================
 * Spec: docs/specs/supply-demand-zone-spec.md
 *
 * Stacks ON TOP of Phase 3 BOSChoChDetector. For each BOS/CHoCh event
 * emitted by the upstream detector, this indicator:
 *
 *   1. Identifies the 起點 (origin pivot) — the structural start of the
 *      move the event reversed/continued
 *   2. Identifies the 發力位置 (force point) — heuristic: the largest
 *      body in the lookback window between origin and event (Q1: A)
 *   3. Frames a rectangular zone with Y = wick-to-wick (Q2)
 *      and X = [origin.barIdx, force.barIdx]
 *   4. Renders a thin dashed extreme-position line at the absolute wick
 *      extreme (= SL placement reference per §4-1(49))
 *   5. Tracks lifecycle: untested → tested → invalidated, freezing the
 *      zone's right edge once invalidated (Q7: until_swept)
 *
 * Dependencies (script ordering in index.html ensures these load first):
 *   - window.BOSChoChDetector  (Phase 3 main — event source)
 *   - window.NWaveIndicator    (transitive — for pivot lookup helpers)
 *
 * NO LOOKAHEAD: KLineChart's calc(dataList) truncation in replay mode
 * automatically suppresses events past the cursor. Zones inherit this
 * via getEventsForChart().
 *
 * Per VISION.md §2.2 (Deterministic engine, AI only narrates): this
 * indicator mechanically frames zones without judging quality. The
 * "is this a good entry zone?" decision is the AI mentor's job
 * (Phase 6) reading zone list + Wister notes.
 *
 * Output API (for Phase 5 backtest + Phase 6 AI mentor):
 *   window.SupplyDemandZones.getZonesForChart(chart) → zones[]
 * ========================================================================== */

(function () {
  const TYPE_NAME = 'supply_demand_zones';
  const KLC_NAME  = 'SupplyDemandZones';

  // Per-pane zone cache so getZonesForChart() can return current state
  // without re-running detection.
  const _zonesByPaneKey = new Map();   // "paneId" -> zones[]
  function _paneKey(paneId) { return paneId || 'candle_pane'; }

  // ---- Defaults / schema ----
  const DEFAULT_PARAMS = {
    // Structure source that drives the zones:
    //   'bos_choch'    — Phase 3 BOSChoChDetector (default, unchanged)
    //   'break_marker' — Wister Span/BreakMarker engine (span-level pairing +
    //                    terminator sealing). Anchors on cleaner, degree-aware
    //                    structure; skip_sealed drops zones on dead structure.
    structure_source: 'bos_choch',
    skip_sealed:      true,   // (break_marker) don't frame zones on sealed/dead structure
    bm_add_span:      false,  // (break_marker) also feed span sub-pivots → finer micro-OB

    // Detection params — must match the upstream BOSChoChDetector to read
    // the same pivot seq the events were generated from.
    left_strength:    1,
    right_strength:   1,
    min_swing_amount: 0,
    swing_unit:       'absolute',
    // break_marker engine params (structure_source = 'break_marker')
    span_ratio_lo:    0.5,
    span_ratio_hi:    2.0,
    min_break_gap:    2,

    // Zone framing
    zone_anchor:       'origin_to_force',   // 'origin_only' | 'origin_to_force' | 'choch_range'
    zone_bounds:       'wick',              // 'body' | 'wick' | 'body_to_wick'  (Q2: wick)
    force_lookback_bars: 10,
    choch_max_lookback_bars: 100,
    skip_oversized_choch: true,             // don't draw a CHoCh zone whose span > choch_max_lookback_bars (super-large degree → view on 1HR/4HR)
    emit_bos_zones:    true,                // Q3
    emit_choch_zones:  true,

    // 極限位置 marker
    show_extreme_line:    true,
    extreme_line_color:   '#787b86',
    extreme_line_extend:  'forward',        // 'event' | 'forward'

    // Lifecycle (Q4: simple version)
    test_threshold_pct:   50,               // price must enter zone by this % to be "tested"
    sweep_threshold_pct:  100,              // close BEYOND extreme by this % of zone height → invalidated
    fade_invalidated:     true,
    // Age-based expiration (post-ship feedback): zones that sit untested
    // for too long become noise — price coming back to a 6-month-old
    // demand zone usually doesn't mean anything. Auto-expire stale zones
    // so the chart stays signal-dense.
    auto_expire_untested: true,             // expire untested zones older than max_untested_age_bars
    max_untested_age_bars: 100,             // bars since event; 0 = never expire
    auto_expire_tested:   false,            // keep tested zones around longer (they're "in play")
    max_tested_age_bars:  300,              // only used if auto_expire_tested = true
    hide_expired:         true,             // true = don't render expired; false = render very faded

    // Visual
    demand_color:        '#26a69a',
    supply_color:        '#ef5350',
    zone_alpha:          0.15,
    zone_alpha_tested:   0.30,
    zone_alpha_inv:      0.05,
    zone_border:         true,
    // Optional: snap the zone's structure-facing edge to the BOS/CHoCh
    // broken-level line and stretch to it. Default OFF — the user wants the
    // compact order-block body itself (origin candle range), supply OB sitting
    // high / demand OB sitting low, NOT a band glued to the line.
    attach_to_break:     false,
    // 'event' | 'forward' | 'until_swept' | 'until_tested'.
    // until_tested (default, per user): the OB box extends right until price
    // FIRST touches it, then freezes at that bar — "碰到就停在碰到的位置".
    zone_extend_right:   'until_tested',
    // Visual cap on how many bars past the event the zone is allowed to
    // extend. Caps BOTH 'forward' and 'until_swept' modes. 0 = no cap
    // (original behaviour). Default 100 prevents zone-clutter when many
    // untested zones stack up in a strong trend.
    // Decoupled from age-based expiration — age controls STATUS (hidden
    // or not), this controls just VISUAL extent.
    right_extension_max_bars: 100,
    show_label:          true,
    show_label_event:    true,               // append the BOS/CHoCh type to the zone label
    // Draw each zone's own BOS/CHoCh structural segment (pivot → break) + a
    // tie to the box, so you can read which structure each zone came from
    // even with the BOSChoChDetector indicator hidden.
    show_event_line:     true,
    label_size:          10,
    label_color:         '#ffffff',
  };

  const SWING_UNIT_OPTIONS = [
    { value: 'absolute', label: '價格點' },
    { value: 'pct',      label: '百分比 %' },
  ];

  const ZONE_ANCHOR_OPTIONS = [
    { value: 'origin_only',     label: 'origin 單根 K' },
    { value: 'origin_to_force', label: 'origin → 發力（預設）' },
    { value: 'choch_range',     label: 'CHoCh 全範圍' },
  ];

  const ZONE_BOUNDS_OPTIONS = [
    { value: 'body',         label: 'body（窄）' },
    { value: 'wick',         label: 'wick（寬，預設）' },
    { value: 'body_to_wick', label: 'body→wick（不對稱）' },
  ];

  const EXTEND_OPTIONS = [
    { value: 'event',        label: 'event（短）' },
    { value: 'forward',      label: 'forward（往右延伸）' },
    { value: 'until_tested', label: 'until_tested（碰到就停，預設）' },
    { value: 'until_swept',  label: 'until_swept（被破才停）' },
  ];

  const EXTREME_EXTEND_OPTIONS = [
    { value: 'event',   label: 'event 短' },
    { value: 'forward', label: 'forward 往右' },
  ];

  // Section labels are LONG for in-body context but the tab strip uses
  // the short `tabLabel` so the 6-tab strip fits inside the dialog
  // width without horizontal scrolling.
  const STRUCTURE_SOURCE_OPTIONS = [
    { value: 'bos_choch',    label: 'BOS/CHoCh（預設）' },
    { value: 'break_marker', label: 'Break Marker（Wister Span）' },
  ];

  const PARAM_SCHEMA = [
    { type: 'section', label: '結構偵測（須與 BOS/CHoCh 相同）', tabLabel: '結構' },
    { key: 'structure_source', label: '結構來源',    type: 'enum', options: STRUCTURE_SOURCE_OPTIONS, default: 'bos_choch' },
    { key: 'skip_sealed',      label: '略過已封印結構（BM）', type: 'bool', default: true },
    { key: 'bm_add_span',      label: '加入 span 微結構（BM）', type: 'bool', default: false },
    { key: 'left_strength',    label: 'LeftStrength',   type: 'int',    min: 1, max: 50, default: 1 },
    { key: 'right_strength',   label: 'RightStrength',  type: 'int',    min: 1, max: 50, default: 1 },
    { key: 'min_swing_amount', label: '最小擺動',        type: 'number', min: 0,          default: 0 },
    { key: 'swing_unit',       label: '單位',            type: 'enum',   options: SWING_UNIT_OPTIONS, default: 'absolute' },

    { type: 'section', label: '範圍識別', tabLabel: '範圍' },
    { key: 'zone_anchor',         label: 'Zone X 範圍', type: 'enum',   options: ZONE_ANCHOR_OPTIONS, default: 'origin_to_force' },
    { key: 'zone_bounds',         label: 'Zone Y 邊界', type: 'enum',   options: ZONE_BOUNDS_OPTIONS, default: 'wick' },
    { key: 'force_lookback_bars', label: '發力回看根數',type: 'int',    min: 1, max: 30, default: 10 },
    { key: 'emit_bos_zones',      label: 'BOS 也框 zone',type: 'bool',                   default: true },
    { key: 'emit_choch_zones',    label: 'CHoCh 框 zone',type: 'bool',                   default: true },

    { type: 'section', label: '極限位置', tabLabel: '極限' },
    { key: 'show_extreme_line',   label: '顯示極限位置線',type: 'bool',                   default: true },
    { key: 'extreme_line_color',  label: '極限線顏色',  type: 'color',                   default: '#787b86' },
    { key: 'extreme_line_extend', label: '極限線延伸',  type: 'enum',   options: EXTREME_EXTEND_OPTIONS, default: 'forward' },

    { type: 'section', label: '生命週期', tabLabel: '週期' },
    { key: 'test_threshold_pct',  label: '進入 zone 多少 % 算 tested', type: 'number', min: 0, max: 100, default: 50 },
    { key: 'sweep_threshold_pct', label: '突破 extreme 多少 % 算 swept', type: 'number', min: 0, max: 200, default: 100 },
    { key: 'fade_invalidated',    label: '失效 zone 淡化',type: 'bool',                   default: true },

    { type: 'section', label: '過期清理（避免老 zone 雜訊）', tabLabel: '清理' },
    { key: 'auto_expire_untested',  label: '自動過期未測試 zone',  type: 'bool', default: true },
    { key: 'max_untested_age_bars', label: '未測試 zone 最大壽命(根)', type: 'int', min: 0, max: 1000, default: 100 },
    { key: 'auto_expire_tested',    label: '已測試 zone 也過期',  type: 'bool', default: false },
    { key: 'max_tested_age_bars',   label: '已測試 zone 最大壽命(根)', type: 'int', min: 0, max: 2000, default: 300 },
    { key: 'hide_expired',          label: '過期 zone 隱藏（否則極淡）', type: 'bool', default: true },

    { type: 'section', label: '顯示', tabLabel: '顯示' },
    { key: 'demand_color',       label: 'Demand 顏色', type: 'color', default: '#26a69a' },
    { key: 'supply_color',       label: 'Supply 顏色', type: 'color', default: '#ef5350' },
    { key: 'zone_alpha',         label: 'Zone 透明度（untested）',type: 'number', min: 0, max: 1, default: 0.15 },
    { key: 'zone_alpha_tested',  label: 'Zone 透明度（tested）',type: 'number', min: 0, max: 1, default: 0.30 },
    { key: 'zone_alpha_inv',     label: 'Zone 透明度（invalidated）',type: 'number', min: 0, max: 1, default: 0.05 },
    { key: 'zone_border',        label: 'Zone 外框',   type: 'bool', default: true },
    { key: 'attach_to_break',    label: '邊緣貼齊 BOS/CHoCh 突破線', type: 'bool', default: true },
    { key: 'zone_extend_right',  label: '右側延伸模式', type: 'enum', options: EXTEND_OPTIONS, default: 'until_swept' },
    { key: 'right_extension_max_bars', label: '右延伸上限(根，0=不限)', type: 'int', min: 0, max: 2000, default: 100 },
    { key: 'show_label',         label: '顯示 Label',  type: 'bool', default: true },
    { key: 'show_label_event',   label: 'Label 標出 BOS/CHoCh', type: 'bool', default: true },
    { key: 'show_event_line',    label: '畫出 BOS/CHoCh 線段 + 牽引線', type: 'bool', default: true },
    { key: 'label_size',         label: 'Label 字級',  type: 'int', min: 8, max: 16, default: 10 },
    { key: 'label_color',        label: 'Label 顏色',  type: 'color', default: '#ffffff' },
  ];

  // ===========================================================================
  // Pure detection functions — operate on (pivot seq, events, dataList, params)
  // ===========================================================================

  /**
   * Find the 起點 (origin pivot) for a BOS/CHoCh event.
   *
   * For a SUPPLY zone (event direction down, either CHoCh down in uptrend or
   * BOS down in downtrend), the origin is the most-recent swing HIGH BEFORE
   * the broken low. That's where the up-leg topped out — the structural
   * starting point of the move that's now reversing/continuing down.
   *
   * For a DEMAND zone (mirror): origin is the most-recent swing LOW BEFORE
   * the broken high.
   *
   * @param {Object} event  — the BOS/CHoCh event
   * @param {Array}  seq    — alternating pivot sequence (same one BOSChoCh used)
   * @returns {Object|null} { barIdx, ts, price, type } of the origin pivot
   */
  function _findOrigin(event, seq) {
    // Preferred: the OB pivot the detector carries on the event — the pullback
    // swing that was still active at the break (the last opposite swing before
    // price broke out). For a bull break that's the pullback LOW (demand OB);
    // for a bear break the pullback HIGH (supply OB). This is the candle the
    // user expects the zone on — NOT the pivot before the broken pivot, which
    // can be a much older low/high sitting on the wrong side of the structure.
    if (event.obPivotBarIdx != null) {
      const p = seq.find(q => q.barIdx === event.obPivotBarIdx);
      if (p) return p;
      // Event carries it but the (possibly differently-filtered) seq doesn't —
      // synthesize a minimal origin so framing can still proceed.
      return {
        barIdx: event.obPivotBarIdx,
        price:  event.obPivotPrice,
        type:   event.direction === 'up' ? 'low' : 'high',
        ts:     null,
      };
    }
    // Fallback (legacy): the pivot immediately before the broken pivot.
    const i = seq.findIndex(p => p.barIdx === event.pivotBarIdx);
    if (i < 1) return null;
    return seq[i - 1];
  }

  function _forceFromBar(dataList, idx) {
    const b = dataList[idx];
    if (!b) return null;
    return {
      barIdx: idx,
      ts: b.timestamp,
      bodyHigh: Math.max(b.open, b.close),
      bodyLow:  Math.min(b.open, b.close),
      high: b.high,
      low: b.low,
    };
  }

  /**
   * Find the 發力位置 / base end per Wister §4-2(13):
   *   「起點是一段上漲的最低點，發力位置是出現上漲前的最後一個打破小結構
   *    N 字的低點」  →  起點 and 發力 are BOTH lows (highs for supply) sitting
   *   at the BASE; the zone is the few-candle range between them
   *   (§上課概念 line 83「以範圍來做選擇」, line 96「趨勢起點的幾根k線範圍」).
   *
   * The base lives in the half of the leg NEAREST the origin. We walk forward
   * from the origin and keep candles while price is still on the origin side
   * of the leg's MIDLINE = (origin.price + brokenLevel) / 2. The first candle
   * that crosses the midline marks where price has left the base and entered
   * the impulsive leg ("發力") — we stop there. The returned bar is the last
   * base candle; the zone is then framed over [origin, base].
   *
   * Why the midline and not "largest opposite body" (the old v1 heuristic):
   * scanning for the biggest body could land a pullback candle half-way up a
   * steep leg, and the wick Y-bounds over [origin, that bar] would then reach
   * UP to (or past) the broken-high level — a DEMAND zone drawn ABOVE its own
   * bull BOS (user-reported bug). Bounding the base to the origin-half of the
   * leg makes "demand.upper < brokenLevel" (and "supply.lower > brokenLevel")
   * a structural guarantee.
   *
   * NOTE: Q1 option B (true sub-degree N Wave force detection) is still the
   * eventual target; this midline rule is the v1 stand-in.
   *
   * @returns {Object|null} { barIdx, ts, bodyHigh, bodyLow, high, low }
   */
  function _findForce(event, origin, dataList, lookbackBars) {
    if (!origin) return null;
    const isSupply = _isSupplyZoneFor(event);
    const startK = origin.barIdx;
    // Cap how far the base may extend (avoids a pathologically wide base when
    // price drifts sideways for a long time before launching).
    const maxK = Math.min(event.eventBarIdx, startK + (lookbackBars | 0));

    const level = Number(event.level);
    const midline = Number.isFinite(level) && Number.isFinite(origin.price)
      ? (origin.price + level) / 2
      : null;

    let baseEnd = startK;
    if (midline != null) {
      for (let k = startK + 1; k <= maxK; k++) {
        const b = dataList[k];
        if (!b || b._placeholder) break;
        // Still in the base while price hasn't crossed the midline:
        //   demand (up-leg)   → base candle's HIGH stays below midline
        //   supply (down-leg) → base candle's LOW  stays above midline
        const stillBase = isSupply ? (b.low > midline) : (b.high < midline);
        if (!stillBase) break;
        baseEnd = k;
      }
    }
    return _forceFromBar(dataList, baseEnd);
  }

  /**
   * Classify an event as supply (above price, short retest) or demand
   * (below price, long retest).
   *
   * Per spec §2.4:
   *   BOS up   → DEMAND (the up-leg's origin is where buyers came in)
   *   BOS down → SUPPLY (the down-leg's origin is where sellers came in)
   *   CHoCh up → DEMAND (down-leg just reversed, bullish bias → demand at bottom)
   *   CHoCh down → SUPPLY (up-leg just reversed, bearish bias → supply at top)
   */
  function _isSupplyZoneFor(event) {
    return event.direction === 'down';
  }

  /**
   * Compute zone Y-bounds from origin+force range.
   * Walks bars in [xLeft, xRight] aggregating high/low (wick) or open/close (body).
   */
  function _computeZoneYBounds(xLeft, xRight, dataList, mode) {
    let topHi = -Infinity, topLo = -Infinity;
    let botHi = +Infinity, botLo = +Infinity;
    for (let k = xLeft; k <= xRight; k++) {
      const b = dataList[k];
      if (!b) continue;
      const bodyHi = Math.max(b.open, b.close);
      const bodyLo = Math.min(b.open, b.close);
      if (b.high > topHi) topHi = b.high;
      if (bodyHi > topLo) topLo = bodyHi;
      if (b.low < botLo) botLo = b.low;
      if (bodyLo < botHi) botHi = bodyLo;
    }
    if (!Number.isFinite(topHi)) return null;
    // 'body'        → bounds = [bodyLo, bodyHi]  (narrowest)
    // 'wick'        → bounds = [wickLo, wickHi]  (widest — Q2 default)
    // 'body_to_wick'→ for supply: [bodyHi, wickHi]; for demand: [wickLo, bodyLo]
    //                  — asymmetric (body on retest side, wick on extreme side)
    // We return { upper, lower, extreme } where extreme = the SL placement
    // reference (always the wick extreme).
    if (mode === 'body') {
      return { upper: topLo, lower: botHi, extremeUp: topHi, extremeDn: botLo };
    }
    if (mode === 'body_to_wick') {
      return { upper: topHi, lower: botHi, asymmetric: true, extremeUp: topHi, extremeDn: botLo };
      // Note: caller picks the right interpretation for supply vs demand.
      // For supply: zone = [bodyHi (lower), wickHi (upper)] — i.e. lower=botHi, upper=topHi
      // For demand: zone = [wickLo (lower), bodyLo (upper)] — caller swaps
    }
    // default 'wick'
    return { upper: topHi, lower: botLo, extremeUp: topHi, extremeDn: botLo };
  }

  /**
   * Main zone framing function — turns an event into a zone object.
   *
   * The OB extreme (demand low / supply high) is the WICK extreme scanned over
   * a window bounded on the right by the break. The LEFT bound depends on the
   * event type (see the scanLo block below):
   *   • BOS  (continuation) → left bound = the broken pivot (起點). The extreme
   *     lives strictly inside the BOS span [起點, 終點]; never reaches earlier.
   *   • CHoCh (reversal)    → left bound = the leg / recent window, so the zone
   *     can anchor at the trend-origin extreme that sits BEFORE the broken level.
   *
   * Returns null if framing not possible.
   */
  function _frameZone(event, seq, dataList, params) {
    const ob = _findOrigin(event, seq);   // pullback pivot (swingLow/High at break)
    if (!ob) return null;
    const isSupply = _isSupplyZoneFor(event);
    const level = Number(event.level);

    // Extreme-scan window. The LEFT bound differs by event type because the
    // order block sits on a different side of the broken pivot:
    //
    // • BOS (continuation) — §4zs, user rule: the extreme MUST lie inside the
    //   BOS's own span [起點 = broken pivot, 終點 = break]. A continuation pulls
    //   back AFTER taking out the structure, so the OB is always to the RIGHT of
    //   the broken pivot; the scan must NOT reach left past it. Clamp scanLo to
    //   event.pivotBarIdx. (Bug this fixes: 2026/05/01 BOS up broke 40234@03:30
    //   but the demand low ran left to 00:30/39779 — an earlier pullback BEFORE
    //   the broken high; clamping gives the correct 04:30/39961, matching the
    //   user's hand-drawn zone. The old obPivot/legStart/force_lookback path
    //   could drag the low past the 起點.)
    //
    // • CHoCh (reversal): the OB is the trend-ORIGIN extreme — the down-leg
    //   bottom for a CHoCh up / up-leg top for a CHoCh down — which legitimately
    //   sits BEFORE the broken level. Keep the leg + recent-window scan so those
    //   reversal zones still anchor at that origin (this is also why §4zr used a
    //   lookback floor instead of clamping to the pivot for everything).
    let scanLo;
    if (event.type === 'BOS') {
      scanLo = Math.max(0, event.pivotBarIdx | 0);
    } else {
      // CHoCh (reversal): anchor at the reversed move's WICK extreme — lowest low
      // (demand) / highest high (supply) — regardless of swing status (user rule
      // 2026-07: "抓那個 range 中最低的 K，不管是不是 swing low"). Scan from the
      // EARLIER (deeper) of two origins to the break:
      //   • the broken pivot — handles the geometry where the reversal low is
      //     AFTER it (Aaron's real cases: break@01:40→42330@22:40, @03:15→42410@02:25);
      //   • the swing-leg origin (trace back through same-side pivots while the
      //     extreme keeps extending) — handles the geometry where the low sits
      //     BEFORE the broken lower-high (the synthetic fixtures).
      // Capped by choch_max_lookback_bars so an ancient broken pivot can't drag
      // the scan to a far-away low (§4zr guard).
      const oi = seq.findIndex(p => p.barIdx === ob.barIdx);
      let swingOrigin = ob.barIdx, ref = level;
      for (let j = oi - 1; j >= 0; j--) {
        const pv = seq[j];
        if (isSupply) { if (pv.type !== 'low') continue; if (pv.price < ref) { ref = pv.price; swingOrigin = pv.barIdx; } else break; }
        else          { if (pv.type !== 'high') continue; if (pv.price > ref) { ref = pv.price; swingOrigin = pv.barIdx; } else break; }
      }
      const cap = event.eventBarIdx - (Number(params.choch_max_lookback_bars) || 100);
      scanLo = Math.max(0, cap, Math.min(swingOrigin, event.pivotBarIdx | 0));
    }
    const scanHi = Math.max(scanLo, event.eventBarIdx - 1);   // exclude the break bar

    // Search the whole leg for the wick extreme on the OB's side.
    let exBar = -1;
    let exPrice = isSupply ? -Infinity : Infinity;
    for (let k = scanLo; k <= scanHi; k++) {
      const b = dataList[k];
      if (!b || b._placeholder) break;
      if (isSupply) { if (b.high > exPrice) { exPrice = b.high; exBar = k; } }
      else          { if (b.low  < exPrice) { exPrice = b.low;  exBar = k; } }
    }
    if (exBar < 0) {
      const b = dataList[ob.barIdx];
      if (!b) return null;
      exBar = ob.barIdx;
      exPrice = isSupply ? b.high : b.low;
    }

    // Inner edge = midline between the extreme and the broken level. Keeps the
    // box on the OB's side and structurally below (demand) / above (supply) the
    // break by construction (demand.upper < level, supply.lower > level).
    const inner = Number.isFinite(level) ? (exPrice + level) / 2 : exPrice;
    let upper, lower, extreme;
    if (isSupply) {
      upper = exPrice;
      lower = Math.min(inner, exPrice);
      extreme = upper;
    } else {
      lower = exPrice;
      upper = Math.max(inner, exPrice);
      extreme = lower;
    }

    // X-range
    let xLeft, xRight;
    if (params.zone_anchor === 'origin_only') {
      xLeft = xRight = exBar;
    } else if (params.zone_anchor === 'choch_range') {
      xLeft = scanLo;
      xRight = event.eventBarIdx;
    } else {  // origin_to_force (default) — spring → end of consolidation
      xLeft = exBar;
      xRight = Math.max(exBar, event.eventBarIdx - 1);
    }

    const exData = dataList[exBar];
    return {
      id:          `${event.type}_${event.direction}_${event.eventBarIdx}`,
      side:        isSupply ? 'supply' : 'demand',
      triggeredBy: { ...event },
      origin:      { barIdx: exBar, ts: exData ? exData.timestamp : null, price: exPrice },
      force:       { barIdx: exBar, ts: exData ? exData.timestamp : null, high: exData ? exData.high : null, low: exData ? exData.low : null },
      bounds: {
        upper, lower, extreme,
        xLeft, xRight,
        height: upper - lower,
      },
      status:           'untested',
      testedAtBarIdx:   null,
      touchedAtBarIdx:  null,   // first bar (after event) whose range touches the OB at all
      sweptAtBarIdx:    null,
      // Set on the first walker pass after framing. Used by 'until_swept' to
      // freeze the right edge.
      activeRightEdge:  null,
    };
  }

  /**
   * Walk bars from event.eventBarIdx forward and progress each zone's
   * lifecycle. Mutates zone.status / .testedAtBarIdx / .sweptAtBarIdx /
   * .activeRightEdge.
   */
  function _advanceLifecycle(zone, dataList, params) {
    // In replay mode dataList ends with a long run of synthetic placeholder
    // bars (Replay.makeFutureSlots appends baseBars.length - cursor + 100 of
    // them). They are NOT real history. Using dataList.length here would
    // inflate every zone's age by hundreds of bars, so EVERY untested zone
    // trips max_untested_age_bars and silently "expires" (hide_expired) the
    // instant you enter replay — the user-reported "demand 一進重播就不見了".
    // Anchor all age / right-edge math to the last REAL bar instead.
    let lastRealIdx = dataList.length - 1;
    while (lastRealIdx >= 0 && dataList[lastRealIdx] && dataList[lastRealIdx]._placeholder) {
      lastRealIdx--;
    }
    const startK = zone.triggeredBy.eventBarIdx + 1;  // bars AFTER the event
    if (startK > lastRealIdx) {
      zone.activeRightEdge = lastRealIdx;
      return;
    }
    const isSupply = zone.side === 'supply';
    const top = zone.bounds.upper;
    const bot = zone.bounds.lower;
    const height = Math.max(zone.bounds.height, 1e-9);
    const testEnterDist = height * (params.test_threshold_pct / 100);
    // For supply: "entered by X%" means price came down to within (top - testEnterDist)
    // For demand: "entered by X%" means price came up to within (bot + testEnterDist)
    const supplyTestLine = top - testEnterDist;
    const demandTestLine = bot + testEnterDist;

    const sweepMargin = height * (params.sweep_threshold_pct / 100);
    const supplySweepLevel = top + sweepMargin;   // bar.close > this → swept
    const demandSweepLevel = bot - sweepMargin;   // bar.close < this → swept

    for (let k = startK; k <= lastRealIdx; k++) {
      const b = dataList[k];
      if (!b) continue;
      // Defensive: placeholders are already excluded by lastRealIdx, but
      // bail anyway if one slips in (per Replay.makeFutureSlots convention).
      if (b._placeholder) break;

      // First-touch check (ANY overlap of the bar's range with the OB body).
      // Drives the 'until_tested' right-edge freeze — "碰到就停". Looser than
      // the test_threshold-gated 'tested' status below.
      if (zone.touchedAtBarIdx == null && b.high >= bot && b.low <= top) {
        zone.touchedAtBarIdx = k;
      }

      // Tested check (price entered the zone by at least test_threshold_pct)
      if (zone.status === 'untested') {
        if (isSupply) {
          // bar's high reached down into the zone past the test line
          if (b.high >= supplyTestLine && b.low <= top) {
            zone.status = 'tested';
            zone.testedAtBarIdx = k;
          }
        } else {
          if (b.low <= demandTestLine && b.high >= bot) {
            zone.status = 'tested';
            zone.testedAtBarIdx = k;
          }
        }
      }

      // Swept / invalidated check (close strictly beyond sweep level)
      if (isSupply) {
        if (b.close > supplySweepLevel) {
          zone.status = 'invalidated';
          zone.sweptAtBarIdx = k;
          zone.activeRightEdge = k;
          return;
        }
      } else {
        if (b.close < demandSweepLevel) {
          zone.status = 'invalidated';
          zone.sweptAtBarIdx = k;
          zone.activeRightEdge = k;
          return;
        }
      }
    }

    // Reached the last real bar without invalidation
    zone.activeRightEdge = lastRealIdx;

    // Age-based expiration check (only applies if NOT already invalidated)
    // Runs AFTER the main walker because we need to know the final status
    // (untested vs tested) to apply the correct max-age threshold.
    const currentBar = lastRealIdx;
    const eventBar = zone.triggeredBy.eventBarIdx;
    if (zone.status === 'untested' && params.auto_expire_untested) {
      const maxAge = params.max_untested_age_bars | 0;
      if (maxAge > 0 && currentBar - eventBar > maxAge) {
        zone.status = 'expired';
        zone.expiredAtBarIdx = eventBar + maxAge;
        // Freeze the right edge at the expiration bar (or current bar,
        // whichever is earlier) so the zone doesn't keep extending right
        // forever in 'until_swept' mode.
        zone.activeRightEdge = Math.min(zone.expiredAtBarIdx, currentBar);
      }
    } else if (zone.status === 'tested' && params.auto_expire_tested) {
      const maxAge = params.max_tested_age_bars | 0;
      const testedBar = zone.testedAtBarIdx || eventBar;
      if (maxAge > 0 && currentBar - testedBar > maxAge) {
        zone.status = 'expired';
        zone.expiredAtBarIdx = testedBar + maxAge;
        zone.activeRightEdge = Math.min(zone.expiredAtBarIdx, currentBar);
      }
    }
  }

  /**
   * Top-level: turn events + bars into zones with full lifecycle resolved.
   * This is what calc() ultimately produces.
   */
  function detectZones(events, seq, dataList, params) {
    if (!Array.isArray(events) || !events.length) return [];
    const skipOversized = params.skip_oversized_choch !== false;
    const maxSpan = Number(params.choch_max_lookback_bars) || 100;
    const zones = [];
    for (const ev of events) {
      if (ev.type === 'BOS'   && !params.emit_bos_zones)   continue;
      if (ev.type === 'CHoCh' && !params.emit_choch_zones) continue;
      // Super-large-degree CHoCh: when its span (broken pivot → break) exceeds
      // the scan cap, the OB scan can't reach the true reversal extreme on THIS
      // TF, so the zone is framed too shallow / spanning multiple positions
      // (user 2026-07: a 15-day CHoCh on 5min frames at 41646 vs the 1HR-correct
      // 39735). Such structure belongs to a larger degree — view it on 1HR/4HR;
      // skip drawing a wrong zone here rather than emit one. Cross-check via the
      // aggregated TF (cross_degree).
      if (skipOversized && ev.type === 'CHoCh'
          && Number.isFinite(ev.eventBarIdx) && Number.isFinite(ev.pivotBarIdx)
          && (ev.eventBarIdx - ev.pivotBarIdx) > maxSpan) continue;
      const zone = _frameZone(ev, seq, dataList, params);
      if (!zone) continue;
      _advanceLifecycle(zone, dataList, params);
      zones.push(zone);
    }
    return zones;
  }

  // ===========================================================================
  // Rendering
  // ===========================================================================

  function _withAlpha(hex, alpha) {
    if (!hex) return `rgba(0,0,0,${alpha})`;
    if (hex.startsWith('rgba')) {
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

  function _zoneAlphaFor(zone, ext) {
    if (zone.status === 'expired')     return (Number(ext.zone_alpha_inv) || DEFAULT_PARAMS.zone_alpha_inv) * 0.5;
    if (zone.status === 'invalidated') return Number(ext.zone_alpha_inv) || DEFAULT_PARAMS.zone_alpha_inv;
    if (zone.status === 'tested')      return Number(ext.zone_alpha_tested) || DEFAULT_PARAMS.zone_alpha_tested;
    return Number(ext.zone_alpha) || DEFAULT_PARAMS.zone_alpha;
  }

  function _rightEdgeBarIdx(zone, ext, n) {
    const mode = ext.zone_extend_right || DEFAULT_PARAMS.zone_extend_right;
    if (mode === 'event') return zone.bounds.xRight;

    let rightIdx;
    if (mode === 'until_tested') {
      // Extend right until price FIRST touches the OB, then freeze there
      // ("碰到就停在碰到的位置"). Expired-but-untouched still freezes at expiry.
      if (zone.touchedAtBarIdx != null) {
        rightIdx = zone.touchedAtBarIdx;
      } else if (zone.status === 'expired' && zone.expiredAtBarIdx != null) {
        rightIdx = zone.expiredAtBarIdx;
      } else {
        rightIdx = n - 1;
      }
    } else if (mode === 'until_swept') {
      // Freeze right edge for any terminal-ish state (invalidated OR expired).
      if (zone.status === 'invalidated' && zone.sweptAtBarIdx != null) {
        rightIdx = zone.sweptAtBarIdx;
      } else if (zone.status === 'expired' && zone.expiredAtBarIdx != null) {
        rightIdx = zone.expiredAtBarIdx;
      } else {
        rightIdx = n - 1;
      }
    } else {
      // 'forward'
      rightIdx = n - 1;
    }

    // Universal visual cap — applies on top of any mode. Default 100
    // bars past the event. 0 disables the cap entirely. Prevents zone
    // clutter when many untested zones stack up during strong trends.
    // Note: this is VISUAL only — the zone's `status` (untested /
    // tested / expired / invalidated) still progresses against full
    // dataList per its own rules. We just stop drawing past the cap.
    const cap = Number(ext.right_extension_max_bars) || 0;
    if (cap > 0) {
      const capEdge = zone.triggeredBy.eventBarIdx + cap;
      if (rightIdx > capEdge) rightIdx = capEdge;
    }
    return rightIdx;
  }

  /**
   * Y-bounds to RENDER (not the structural bounds used for lifecycle). With
   * attach_to_break on, the structure-facing edge snaps to the BOS/CHoCh
   * broken-level line so the zone visually hangs off that exact line:
   *   demand → upper edge = broken high   (the BOS/CHoCh-up line)
   *   supply → lower edge = broken low    (the BOS/CHoCh-down line)
   * The opposite edge stays at the order-block extreme. Lifecycle / extreme
   * line keep using zone.bounds (the real base) — this only changes drawing.
   */
  function _zoneRenderBounds(zone, ext) {
    let upper = zone.bounds.upper;
    let lower = zone.bounds.lower;
    const lvl = zone.triggeredBy ? Number(zone.triggeredBy.level) : NaN;
    if (ext.attach_to_break !== false && Number.isFinite(lvl)) {
      if (zone.side === 'supply') {
        if (lvl < upper) lower = lvl;   // keep upper > lower
      } else {
        if (lvl > lower) upper = lvl;
      }
    }
    return { upper, lower };
  }

  function _drawZone(ctx, zone, ext, xAxis, yAxis, kLineDataList) {
    if (zone.status === 'invalidated' && !ext.fade_invalidated) return;
    if (zone.status === 'expired' && ext.hide_expired !== false) return;
    const isSupply = zone.side === 'supply';
    const color = isSupply ? (ext.supply_color || DEFAULT_PARAMS.supply_color)
                           : (ext.demand_color || DEFAULT_PARAMS.demand_color);
    const alpha = _zoneAlphaFor(zone, ext);
    const n = kLineDataList.length;
    const xRightIdx = _rightEdgeBarIdx(zone, ext, n);

    const rb = _zoneRenderBounds(zone, ext);
    const xL = xAxis.convertToPixel(zone.bounds.xLeft);
    const xR = xAxis.convertToPixel(xRightIdx);
    const yT = yAxis.convertToPixel(rb.upper);
    const yB = yAxis.convertToPixel(rb.lower);
    if (![xL, xR, yT, yB].every(Number.isFinite)) return;
    if (xR <= xL) return;
    const w = xR - xL;
    const h = yB - yT;
    if (Math.abs(h) < 1) return;

    ctx.save();
    ctx.fillStyle = _withAlpha(color, alpha);
    ctx.fillRect(xL, Math.min(yT, yB), w, Math.abs(h));
    if (ext.zone_border) {
      ctx.strokeStyle = _withAlpha(color, 0.40);
      ctx.lineWidth = 1;
      ctx.strokeRect(xL, Math.min(yT, yB), w, Math.abs(h));
    }
    ctx.restore();
  }

  function _drawExtremeLine(ctx, zone, ext, xAxis, yAxis, kLineDataList) {
    if (!ext.show_extreme_line) return;
    if (zone.status === 'invalidated' && !ext.fade_invalidated) return;
    if (zone.status === 'expired' && ext.hide_expired !== false) return;
    const n = kLineDataList.length;
    const extMode = ext.extreme_line_extend || DEFAULT_PARAMS.extreme_line_extend;
    const xRightIdx = extMode === 'event' ? zone.bounds.xRight
                                          : _rightEdgeBarIdx(zone, ext, n);
    const xL = xAxis.convertToPixel(zone.bounds.xLeft);
    const xR = xAxis.convertToPixel(xRightIdx);
    const y  = yAxis.convertToPixel(zone.bounds.extreme);
    if (![xL, xR, y].every(Number.isFinite) || xR <= xL) return;
    const color = ext.extreme_line_color || DEFAULT_PARAMS.extreme_line_color;
    ctx.save();
    ctx.strokeStyle = zone.status === 'invalidated' ? _withAlpha(color, 0.40) : color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(xL, y);
    ctx.lineTo(xR, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function _drawLabel(ctx, zone, ext, xAxis, yAxis) {
    if (!ext.show_label) return;
    if (zone.status === 'invalidated') return;   // don't clutter with dead-zone labels
    if (zone.status === 'expired') return;       // same — expired zones are noise
    const fontSize = Number(ext.label_size) || DEFAULT_PARAMS.label_size;
    const lblColor = ext.label_color || DEFAULT_PARAMS.label_color;
    // Tag the zone with the structural event that formed it so the user can
    // trace each zone back to its BOS / CHoCh. Uppercase CHOCH matches the
    // BOSChoChDetector marker text style.
    const side = zone.side === 'supply' ? 'SUPPLY' : 'DEMAND';
    const evType = zone.triggeredBy
      ? (zone.triggeredBy.type === 'CHoCh' ? 'CHOCH' : 'BOS')
      : '';
    const text = (ext.show_label_event !== false && evType) ? `${side} · ${evType}` : side;
    const rb = _zoneRenderBounds(zone, ext);
    const x = xAxis.convertToPixel(zone.bounds.xLeft);
    // Place above body for supply, below for demand — sits just inside the
    // structure-facing edge (the broken-level line when attach_to_break is on).
    const y = zone.side === 'supply'
      ? yAxis.convertToPixel(rb.lower) - 2
      : yAxis.convertToPixel(rb.upper) + 2;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    ctx.save();
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = lblColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = zone.side === 'supply' ? 'bottom' : 'top';
    ctx.fillText(text, x + 3, y);
    ctx.restore();
  }

  /**
   * Draw the structural BOS / CHoCh that formed this zone, so the user can
   * read "from which pivot to which break" each zone is derived from. Renders:
   *   1. the broken-level segment   pivotBarIdx ──► eventBarIdx  @ level
   *      (BOS solid / CHoCh dashed, in the zone's colour — mirrors the
   *       BOSChoChDetector marker so it overlaps cleanly when that indicator
   *       is also on, and stands alone when it's hidden)
   *   2. a faint tie from that segment to the zone body (which OB ↔ which break)
   *   3. a small dot pinning the break point + a BOS/CHOCH tag at the break
   * No label duplication concern: the segment tag is only the type word; the
   * zone's own "SIDE · TYPE" label stays on the box.
   */
  function _drawEventLine(ctx, zone, ext, xAxis, yAxis) {
    if (ext.show_event_line === false) return;
    if (zone.status === 'invalidated' && !ext.fade_invalidated) return;
    if (zone.status === 'expired' && ext.hide_expired !== false) return;
    const ev = zone.triggeredBy;
    if (!ev || !Number.isFinite(Number(ev.level))) return;
    const isSupply = zone.side === 'supply';
    const isCHoCh  = ev.type === 'CHoCh';
    // When the structure comes from Break Marker, match its own line colour
    // (bull blue / bear orange) so the CHoCh/BOS segment + label read as the
    // same structure line. Falls back to the S/D supply/demand colour otherwise.
    const color = ev.bmColor || (isSupply ? (ext.supply_color || DEFAULT_PARAMS.supply_color)
                                          : (ext.demand_color || DEFAULT_PARAMS.demand_color));

    const y      = yAxis.convertToPixel(ev.level);
    const xPivot = xAxis.convertToPixel(ev.pivotBarIdx);
    const xEvent = xAxis.convertToPixel(ev.eventBarIdx);
    if (![y, xPivot, xEvent].every(Number.isFinite)) return;
    const segL = Math.min(xPivot, xEvent);
    const segR = Math.max(xPivot, xEvent);

    ctx.save();

    // (2) faint tie: segment (pivot end) → zone body near its left edge.
    const tieX = xAxis.convertToPixel(zone.bounds.xLeft);
    const tieY = yAxis.convertToPixel(isSupply ? zone.bounds.lower : zone.bounds.upper);
    if (Number.isFinite(tieX) && Number.isFinite(tieY)) {
      ctx.strokeStyle = _withAlpha(color, 0.45);
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(segL, y);
      ctx.lineTo(tieX, tieY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // (1) the broken-level segment pivot ──► break.
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(isCHoCh ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(segL, y);
    ctx.lineTo(segR, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // (3) dot at the break + type tag.
    ctx.fillStyle = _withAlpha(color, 0.85);
    ctx.beginPath();
    ctx.arc(xEvent, y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    if (ext.show_label_event !== false) {
      // CHoCh/BOS tag: coloured to MATCH the event line, CENTRED on the
      // pivot→break segment, and placed ABOVE the line for demand (bull) /
      // BELOW the line for supply (bear).
      ctx.font = 'bold italic 10px sans-serif';
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      const segMid = (segL + segR) / 2;
      if (isSupply) { ctx.textBaseline = 'top';    ctx.fillText(isCHoCh ? 'CHOCH' : 'BOS', segMid, y + 3); }
      else          { ctx.textBaseline = 'bottom'; ctx.fillText(isCHoCh ? 'CHOCH' : 'BOS', segMid, y - 3); }
    }
    ctx.restore();
  }

  // ===========================================================================
  // KLineChart template
  // ===========================================================================

  function _buildKlineTemplate() {
    return {
      name: KLC_NAME,
      shortName: 'S/D Zones',
      calcParams: [
        DEFAULT_PARAMS.left_strength,
        DEFAULT_PARAMS.right_strength,
        DEFAULT_PARAMS.min_swing_amount,
        DEFAULT_PARAMS.swing_unit,
        DEFAULT_PARAMS.zone_anchor,
        DEFAULT_PARAMS.zone_bounds,
        DEFAULT_PARAMS.force_lookback_bars,
        DEFAULT_PARAMS.emit_bos_zones,
        DEFAULT_PARAMS.emit_choch_zones,
        DEFAULT_PARAMS.test_threshold_pct,
        DEFAULT_PARAMS.sweep_threshold_pct,
        DEFAULT_PARAMS.auto_expire_untested,
        DEFAULT_PARAMS.max_untested_age_bars,
        DEFAULT_PARAMS.auto_expire_tested,
        DEFAULT_PARAMS.max_tested_age_bars,
        // right_extension_max_bars is render-only (no recalc needed),
        // but include it in calcParams anyway so overrideIndicator
        // diffs see the change and triggers a redraw.
        DEFAULT_PARAMS.right_extension_max_bars,
        DEFAULT_PARAMS.structure_source,
        DEFAULT_PARAMS.skip_sealed,
        DEFAULT_PARAMS.span_ratio_lo,
        DEFAULT_PARAMS.span_ratio_hi,
        DEFAULT_PARAMS.min_break_gap,
        DEFAULT_PARAMS.bm_add_span,
      ],
      extendData: { ...DEFAULT_PARAMS },
      styles: { tooltip: { showRule: 'none' } },

      // Re-runs the underlying BOS/CHoCh detection (we don't read upstream
      // BOSChoChDetector's runtime state — we compute our own to avoid
      // ordering dependencies). Then frames zones and resolves lifecycle.
      calc(dataList, indicator) {
        const cp  = (indicator && indicator.calcParams) || [];
        const ext = (indicator && indicator.extendData) || {};
        const params = {
          left_strength:        cp[0] ?? ext.left_strength        ?? DEFAULT_PARAMS.left_strength,
          right_strength:       cp[1] ?? ext.right_strength       ?? DEFAULT_PARAMS.right_strength,
          min_swing_amount:     cp[2] ?? ext.min_swing_amount     ?? DEFAULT_PARAMS.min_swing_amount,
          swing_unit:           cp[3] || ext.swing_unit           || DEFAULT_PARAMS.swing_unit,
          zone_anchor:          cp[4] || ext.zone_anchor          || DEFAULT_PARAMS.zone_anchor,
          zone_bounds:          cp[5] || ext.zone_bounds          || DEFAULT_PARAMS.zone_bounds,
          force_lookback_bars:  cp[6] ?? ext.force_lookback_bars  ?? DEFAULT_PARAMS.force_lookback_bars,
          emit_bos_zones:       cp[7] !== undefined ? cp[7] : (ext.emit_bos_zones !== false),
          emit_choch_zones:     cp[8] !== undefined ? cp[8] : (ext.emit_choch_zones !== false),
          test_threshold_pct:    cp[9]  ?? ext.test_threshold_pct    ?? DEFAULT_PARAMS.test_threshold_pct,
          sweep_threshold_pct:   cp[10] ?? ext.sweep_threshold_pct   ?? DEFAULT_PARAMS.sweep_threshold_pct,
          auto_expire_untested:  cp[11] !== undefined ? cp[11] : (ext.auto_expire_untested !== false),
          max_untested_age_bars: cp[12] ?? ext.max_untested_age_bars ?? DEFAULT_PARAMS.max_untested_age_bars,
          auto_expire_tested:    cp[13] !== undefined ? cp[13] : (ext.auto_expire_tested === true),
          max_tested_age_bars:   cp[14] ?? ext.max_tested_age_bars   ?? DEFAULT_PARAMS.max_tested_age_bars,
          structure_source:      cp[16] || ext.structure_source || DEFAULT_PARAMS.structure_source,
          skip_sealed:           cp[17] !== undefined ? cp[17] : (ext.skip_sealed !== false),
          span_ratio_lo:         cp[18] ?? ext.span_ratio_lo ?? DEFAULT_PARAMS.span_ratio_lo,
          span_ratio_hi:         cp[19] ?? ext.span_ratio_hi ?? DEFAULT_PARAMS.span_ratio_hi,
          min_break_gap:         cp[20] ?? ext.min_break_gap ?? DEFAULT_PARAMS.min_break_gap,
          bm_add_span:           cp[21] !== undefined ? cp[21] : (ext.bm_add_span === true),
        };

        let seq, events;
        if (params.structure_source === 'break_marker') {
          // ---- Break Marker (Wister Span) event source ----
          const BM = window.BreakMarker;
          if (!BM || typeof BM.detect !== 'function') {
            console.warn('[SupplyDemandZones] BreakMarker dependency missing');
            return new Array(dataList.length).fill(null);
          }
          // MC-faithful RAW swing pivots — deliberately NOT amplitude-filtered
          // (MC feeds _Wister_SwingPivot raw; min_swing_amount is a bos_choch/
          // fractal knob and would over-collapse the dense swing base). Density
          // control for break_marker comes from skip_sealed + the planned level
          // filter, not from swing amplitude.
          seq = BM.swingPivots(dataList, { add_span: params.bm_add_span });
          const res = BM.detect(dataList, seq, {
            span_ratio_lo: params.span_ratio_lo, span_ratio_hi: params.span_ratio_hi, min_break_gap: params.min_break_gap,
          });
          events = BM.toZoneEvents(res, seq, dataList);
          // drop zones on sealed/dead structure (the precision win); emit
          // BOS/CHoCh toggles are applied downstream by detectZones.
          if (params.skip_sealed) events = events.filter(e => !e.bmSealed);
        } else {
          // ---- BOS/CHoCh detector event source (default, unchanged) ----
          const N = window.NWaveIndicator;
          if (!N || typeof N.detectAlternatingSequence !== 'function' || typeof N.applyAmplitudeFilter !== 'function') {
            console.warn('[SupplyDemandZones] NWaveIndicator dependency missing');
            return new Array(dataList.length).fill(null);
          }
          seq = N.detectAlternatingSequence(dataList, params.left_strength, params.right_strength);
          seq = N.applyAmplitudeFilter(seq, Number(params.min_swing_amount) || 0, params.swing_unit);

          const BCD = window.BOSChoChDetector;
          if (!BCD || typeof BCD.detectEventsFromSeq !== 'function') {
            console.warn('[SupplyDemandZones] BOSChoChDetector dependency missing');
            return new Array(dataList.length).fill(null);
          }
          events = BCD.detectEventsFromSeq(seq, dataList, {
            left_strength:           params.left_strength,
            right_strength:          params.right_strength,
            min_swing_amount:        params.min_swing_amount,
            swing_unit:              params.swing_unit,
            require_close_break:     ext.require_close_break     !== undefined ? ext.require_close_break     : true,
            enforce_choch_below_bos: ext.enforce_choch_below_bos !== undefined ? ext.enforce_choch_below_bos : true,
          });
        }

        // Step 3: frame zones + advance lifecycle
        const zones = detectZones(events, seq, dataList, params);

        const pkey = _paneKey(indicator && indicator.paneId);
        _zonesByPaneKey.set(pkey, zones);

        const out = new Array(dataList.length).fill(null);
        if (out.length > 0) out[0] = { zones };
        return out;
      },

      draw({ ctx, kLineDataList, indicator, visibleRange, xAxis, yAxis }) {
        const ext = (indicator && indicator.extendData) || {};
        if (ext.hidden === true) return false;
        const result = indicator && indicator.result;
        if (!Array.isArray(result) || result.length === 0) return false;
        const zones = (result[0] && result[0].zones) || [];
        if (!zones.length) return false;
        drawZones(ctx, zones, ext, xAxis, yAxis, kLineDataList, visibleRange);
        return false;
      },
    };
  }

  // Reusable zone renderer (extracted from the template draw) so other
  // indicators (e.g. Break Marker's built-in "show zones") can draw the exact
  // same S/D zones from their own structure without duplicating the pipeline.
  function drawZones(ctx, zones, ext, xAxis, yAxis, kLineDataList, visibleRange) {
    if (!Array.isArray(zones) || !zones.length) return;
    const from = visibleRange && visibleRange.realFrom != null ? visibleRange.realFrom : (visibleRange ? visibleRange.from : 0);
    const to   = visibleRange && visibleRange.realTo   != null ? visibleRange.realTo   : (visibleRange ? visibleRange.to   : kLineDataList.length - 1);
    const n = kLineDataList.length;
    const ordered = zones.slice().sort((a, b) => {
      const rank = { 'invalidated': 0, 'untested': 1, 'tested': 2 };
      return (rank[a.status] || 0) - (rank[b.status] || 0);
    });
    for (const zone of ordered) {
      const xRightIdx = _rightEdgeBarIdx(zone, ext, n);
      if (xRightIdx < from - 2) continue;
      if (zone.bounds.xLeft > to + 2) continue;
      _drawZone(ctx, zone, ext, xAxis, yAxis, kLineDataList);
      _drawExtremeLine(ctx, zone, ext, xAxis, yAxis, kLineDataList);
      _drawEventLine(ctx, zone, ext, xAxis, yAxis);
      _drawLabel(ctx, zone, ext, xAxis, yAxis);
    }
  }

  // ===========================================================================
  // Indicator registration plumbing
  // ===========================================================================

  function _paramsToCalc(p) {
    return [
      p.left_strength,
      p.right_strength,
      p.min_swing_amount,
      p.swing_unit,
      p.zone_anchor,
      p.zone_bounds,
      p.force_lookback_bars,
      p.emit_bos_zones,
      p.emit_choch_zones,
      p.test_threshold_pct,
      p.sweep_threshold_pct,
      p.auto_expire_untested,
      p.max_untested_age_bars,
      p.auto_expire_tested,
      p.max_tested_age_bars,
      p.right_extension_max_bars,
      p.structure_source,
      p.skip_sealed,
      p.span_ratio_lo,
      p.span_ratio_hi,
      p.min_break_gap,
      p.bm_add_span,
    ];
  }

  function _paramsToExtend(p) {
    // Mirror everything to extendData so draw() sees full visual config
    // AND so a stray override doesn't lose detection params.
    return { ...DEFAULT_PARAMS, ...p };
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
    _zonesByPaneKey.delete(_paneKey(paneId));
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

  // Public API for Phase 5+ consumers
  function getZonesForChart(_chart, paneId) {
    return _zonesByPaneKey.get(_paneKey(paneId)) || [];
  }

  // ---- Public registration ----
  window.SupplyDemandZones = {
    type:          TYPE_NAME,
    name:          'Supply / Demand Zones',
    defaultParams: { ...DEFAULT_PARAMS },
    paramSchema:   PARAM_SCHEMA,
    klineTemplate: _buildKlineTemplate(),
    // Opt-in to tabbed settings panel — schema has 6 sections × ~5 params
    // each. Without tabs the dialog extends past viewport bottom. Other
    // indicators (Swing Pivot / N Wave / MicroPivot / BOS-CHoCh) stay
    // flat-rendered (their default — no `tabbedPanel` flag).
    tabbedPanel:   true,
    add,
    remove,
    applyParams,
    // Pure functions for tests + Phase 5/6 consumers:
    detectZones,          // (events, seq, dataList, params) → zones[]
    drawZones,            // (ctx, zones, ext, xAxis, yAxis, kLineDataList, visibleRange)
    getZonesForChart,
    // Lower-level for unit tests:
    _findOrigin,
    _findForce,
    _frameZone,
    _advanceLifecycle,
    _zoneRenderBounds,
  };
})();
