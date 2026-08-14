/* ============================================================================
 * span_structure.js — Span-based CHoCh / BOS detector (experimental, Phase §4zt)
 * ============================================================================
 * A NEW indicator that runs ALONGSIDE the existing `bos_choch` and
 * `supply_demand_zones` (those are untouched). Created so the user can compare
 * the two approaches side by side.
 *
 * IDEA (user, 2026-05): drop the fractal `strength` filter entirely. Treat
 * EVERY bar's high/low as a candidate pivot, keep an all-bar monotonic stack of
 * UNBROKEN highs / lows, and when price breaks one, the SPAN (#bars from the
 * broken level to the break bar) *is* the degree (級別). A single break bar
 * naturally takes out a whole staircase of lower-highs → resolving to the most
 * significant (highest) one recovers structures that `strength`-N pivots smooth
 * away (e.g. the 2026/05/14 15:30 break of the 10:00 high, span≈9, which the
 * strength-3 engine missed — it only saw the span-5 break of the 12:30 bounce).
 *
 * This is the same pendingHighs/pendingLows machine as bos_choch.js §4zp, but
 * fed by ALL bars instead of a strength-filtered seq, plus span + degree.
 *
 * Pure core (`detectSpanEvents`) has NO DOM / chart access → unit-testable.
 *   window.SpanStructure.detectSpanEvents(dataList, params) → events[]
 * ========================================================================== */
(function () {
  const TYPE_NAME = 'span_structure';
  const KLC_NAME  = 'SpanStructure';

  const _eventsByPaneKey = new Map();
  function _paneKey(paneId) { return paneId || 'candle_pane'; }

  // ---- Defaults / schema ----
  const DEFAULT_PARAMS = {
    // Detection
    require_close_break: false,   // user's idea is wick-based "price breaks it"
    min_span:            4,       // drop micro-noise: ignore breaks shorter than this
    max_span:            100,     // cap how far back a break may resolve (0 = uncapped)
    min_swing_amount:    0,       // optional amplitude floor on the broken leg (0 = off)
    // N-wave backbone — provides the clean TREND the all-bar legs are labelled
    // against (BOS = with trend / CHoCh = against). The strength is the skeleton
    // grain, NOT a per-event filter (all-bar still catches the fine levels).
    backbone_strength:   3,
    backbone_min_swing:  0,
    // §4zt v2 (user 2026-06): trend model.
    //   'backbone' — trend from the N-wave skeleton (v1, default; keeps tests).
    //   'flip'     — trend evolves from the all-bar legs themselves and flips on
    //                each genuine CHoCh; a counter break that re-extends a prior
    //                same-dir structure is a confirming BOS (reversal) that
    //                invalidates the opposite warning CHoCh. No backbone dep.
    trend_mode:          'backbone',
    // Degree (級別) bands by span — tunable; §4zq tentative 小<10 / 中10~30 / 大>30
    degree_mid_min:      10,
    degree_large_min:    30,
    // §4zt v2: a non-extending BOS within this fraction of the prevailing anchor
    // is a near-duplicate → marked INVALIDATED (X) rather than dropped.
    dedup_frac:          0.0015,
    // Display
    show_small:          true,
    show_mid:            true,
    show_large:          true,
    show_span_in_label:  true,    // label = "BOS 9" instead of just "BOS"
    // Colour by DIRECTION (bull/bear), not by type — red = bear (down-break),
    // green = bull (up-break). BOS vs CHoCh is shown by line style instead
    // (BOS solid / CHoCh dashed).
    bull_color:          '#26a69a',   // up-break  (bullish)
    bear_color:          '#ef5350',   // down-break (bearish)
    label_color:         '#ffffff',
    marker_text_size:    11,
  };

  const PARAM_SCHEMA = [
    { type: 'section', label: '結構偵測（每根 K 都當 pivot）' },
    { key: 'require_close_break', label: '收盤價突破才算', type: 'bool',   default: false },
    { key: 'min_span',            label: '最小 span（根）', type: 'int',    min: 1, max: 50, default: 4 },
    { key: 'max_span',            label: '最大 span 封頂', type: 'int',    min: 0, max: 500, default: 100 },
    { key: 'min_swing_amount',    label: '最小擺動振幅',     type: 'number', min: 0,          default: 0 },

    { type: 'section', label: '趨勢模型' },
    { key: 'trend_mode', label: '趨勢來源', type: 'enum', default: 'backbone', options: [
      { value: 'backbone', label: 'N-wave 骨架（v1）' },
      { value: 'flip',     label: '依破口翻轉（每個真 CHoCh 就翻）' },
    ] },
    { key: 'backbone_strength',  label: '骨架 strength（backbone 模式）', type: 'int',    min: 1, max: 30, default: 3 },
    { key: 'backbone_min_swing', label: '骨架最小擺動（backbone 模式）',   type: 'number', min: 0,          default: 0 },

    { type: 'section', label: '級別帶（依 span 根數）' },
    { key: 'degree_mid_min',   label: '中級別起點（≥）', type: 'int', min: 2,  max: 100, default: 10 },
    { key: 'degree_large_min', label: '大級別起點（≥）', type: 'int', min: 5,  max: 300, default: 30 },
    { key: 'dedup_frac',       label: '近似失效容差（×價）', type: 'number', min: 0, max: 0.05, default: 0.0015 },

    { type: 'section', label: '顯示' },
    { key: 'show_small',         label: '顯示 小級別', type: 'bool',  default: true },
    { key: 'show_mid',           label: '顯示 中級別', type: 'bool',  default: true },
    { key: 'show_large',         label: '顯示 大級別', type: 'bool',  default: true },
    { key: 'show_span_in_label', label: 'Label 顯示 span', type: 'bool', default: true },
    { key: 'bull_color',         label: '多頭(向上) 顏色', type: 'color', default: '#26a69a' },
    { key: 'bear_color',         label: '空頭(向下) 顏色', type: 'color', default: '#ef5350' },
    { key: 'label_color',        label: 'Label 顏色', type: 'color', default: '#ffffff' },
    { key: 'marker_text_size',   label: 'Marker 字級', type: 'int', min: 8, max: 18, default: 11 },
  ];

  // ===========================================================================
  // Core detection — pure, no DOM / chart access
  // ===========================================================================

  function degreeOf(span, params) {
    const midMin   = (params && params.degree_mid_min)   || DEFAULT_PARAMS.degree_mid_min;
    const largeMin = (params && params.degree_large_min) || DEFAULT_PARAMS.degree_large_min;
    if (span >= largeMin) return 'large';
    if (span >= midMin)   return 'mid';
    return 'small';
  }

  /**
   * Leg-based, per-degree-band structure detector (§4zt). Three stages:
   *
   *   1. ALL-BAR BREAK STREAM — every bar's high/low is a candidate pivot, held
   *      on a monotonic stack. When a bar takes out unbroken prior highs/lows,
   *      resolve to the MOST SIGNIFICANT (highest high / lowest low) and record a
   *      break {dir, brokenBar, breakBar, span, level}. This is what lets a
   *      far-back high (the 05/14 10:00 high, span 9) stay breakable where a
   *      strength-N / zigzag pivot would have smoothed it away.
   *
   *   2. LEGS — collapse a run of SAME-DIRECTION breaks into one leg. ANY
   *      opposite break (a pullback, of any size) ENDS the leg. So one continuous
   *      impulse that takes out a whole staircase of old highs = ONE leg
   *      (the CHoCh/BOS "extends to the final extreme"), but a rise→pullback→rise
   *      is TWO legs (→ CHoCh then BOS). The leg keeps the most significant
   *      (deepest/furthest) broken pivot + the LAST break bar as its terminal.
   *
   *   3. PER-BAND LABEL — each leg drops into a degree band by its span
   *      (small/mid/large). Each band keeps its OWN trend, so a span-3 small leg
   *      can never flip the mid/large trend (no more "small CHoCh → big BOS").
   *      A leg in the band's trend dir = BOS; against = CHoCh (flips that band's
   *      trend). §1-1: a CHoCh's level must be on the correct side of the band's
   *      last BOS. CHoCh-before-BOS + CHoCh-outside-BOS fall out of the ordering.
   *
   * @returns {Array} events [{type, direction, pivotBarIdx, pivotTs, level,
   *                           eventBarIdx, eventTs, span, degree, trendBefore}]
   */
  function detectSpanEvents(dataList, params) {
    if (!Array.isArray(dataList) || dataList.length === 0) return [];
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    const requireClose = !!p.require_close_break;
    const minSpan = Math.max(1, p.min_span | 0);
    // Cap how far back a break may resolve. Without it the never-cleared stacks
    // let a single break reach a high/low hundreds of bars back (span 400+),
    // and the CHoCh-extend rule then swallows everything between → runaway large
    // band. maxSpan prunes pending pivots older than this. 0 = uncapped.
    const maxSpan = Math.max(0, p.max_span | 0);
    const bandOf = (span) => degreeOf(span, p);
    const dupFrac = Number(p.dedup_frac) || DEFAULT_PARAMS.dedup_frac;

    // ---- Stage 1: all-bar break stream ----
    // A single break bar can take out several stacked highs/lows; we resolve to
    // the MOST significant. Any OTHER pivot it took out that sits within
    // dedup_frac of the chosen one is a near-duplicate "loser" → recorded so it
    // can later surface as an invalidated (X) sibling (the user's BOS-X 41841 vs
    // BOS-O 41850), without disturbing stages 2–3.
    const breaks = [];
    const nearDupLosers = [];
    let pendingHighs = [], pendingLows = [];
    const n = dataList.length;
    for (let K = 0; K < n; K++) {
      const bar = dataList[K];
      if (!bar) continue;
      if (bar._placeholder) break;   // replay safety
      if (maxSpan > 0) {
        pendingHighs = pendingHighs.filter(h => K - h.barIdx <= maxSpan);
        pendingLows  = pendingLows.filter(l => K - l.barIdx <= maxSpan);
      }
      const refU = requireClose ? bar.close : bar.high;
      if (pendingHighs.length) {
        let t = null;
        for (const h of pendingHighs) if (refU > h.price && (!t || h.price > t.price)) t = h;
        if (t) {
          breaks.push({ dir: 'up', brokenBar: t.barIdx, breakBar: K, level: t.price });
          for (const h of pendingHighs) if (h !== t && refU > h.price && Math.abs(h.price - t.price) <= t.price * dupFrac) nearDupLosers.push({ dir: 'up', brokenBar: h.barIdx, breakBar: K, level: h.price });
          pendingHighs = pendingHighs.filter(h => !(refU > h.price));
        }
      }
      const refD = requireClose ? bar.close : bar.low;
      if (pendingLows.length) {
        let t = null;
        for (const l of pendingLows) if (refD < l.price && (!t || l.price < t.price)) t = l;
        if (t) {
          breaks.push({ dir: 'down', brokenBar: t.barIdx, breakBar: K, level: t.price });
          for (const l of pendingLows) if (l !== t && refD < l.price && Math.abs(l.price - t.price) <= t.price * dupFrac) nearDupLosers.push({ dir: 'down', brokenBar: l.barIdx, breakBar: K, level: l.price });
          pendingLows = pendingLows.filter(l => !(refD < l.price));
        }
      }
      pendingHighs = pendingHighs.filter(h => h.price > bar.high); pendingHighs.push({ barIdx: K, price: bar.high });
      pendingLows  = pendingLows.filter(l => l.price < bar.low);   pendingLows.push({ barIdx: K, price: bar.low });
    }

    // ---- Stage 2: merge same-direction runs into legs ----
    const legs = [];
    let cur = null;
    for (const b of breaks) {
      if (!cur || cur.dir !== b.dir) {
        if (cur) legs.push(cur);
        cur = { dir: b.dir, brokenBar: b.brokenBar, level: b.level, breakBar: b.breakBar };
      } else {
        const deeper = b.dir === 'up' ? b.level > cur.level : b.level < cur.level;
        if (deeper) { cur.brokenBar = b.brokenBar; cur.level = b.level; }
        cur.breakBar = b.breakBar;
      }
    }
    if (cur) legs.push(cur);

    // ---- Stage 3: label each leg by the N-WAVE BACKBONE trend ----
    // The all-bar legs catch the break LEVELS (incl. ones a strength-N pivot
    // smooths away), but they cannot define "trend" on their own without dead-
    // locking. So the TREND comes from a clean N-wave swing skeleton (one
    // strength) run through the existing bos_choch state machine: backbone[]
    // is its CHoCh/BOS events; `trendAt(K)` = the direction of the last backbone
    // event at/before bar K. Then a leg WITH the backbone trend = BOS, AGAINST =
    // CHoCh; `span` gives the (sub-)degree. This is the N-wave ⊕ span hybrid: the
    // skeleton answers "what is the trend / is this internal", span answers "how
    // big + which level", together resolving the span-only dead-lock + the
    // "internal bounce vs structure" ambiguity (e.g. 05/14 15:30 → the backbone
    // says the leg is bearish, so breaking the 10:00 high is a small CHoCh up).
    const mode = (p.trend_mode === 'flip') ? 'flip' : 'backbone';
    // Per band: an evolving `trend` plus per-DIRECTION structure
    // { anchor, chochEnd, chochIdx }. In 'backbone' mode the trend comes from the
    // N-wave skeleton; in 'flip' mode it evolves from the legs themselves.
    const mk = () => ({ trend: null,
                        up: { anchor: null, chochEnd: -1, chochIdx: null },
                        down: { anchor: null, chochEnd: -1, chochIdx: null } });
    const st = { small: mk(), mid: mk(), large: mk() };
    // Band ranking for cross-degree (big→small) cascade. A confirmed BOS may
    // invalidate the opposite structure in its OWN band and SMALLER ones, never
    // a larger band (§4zt cascade rule + Wister §6-2(11) 不連續).
    const BAND_RANK = { small: 0, mid: 1, large: 2 };
    const bandsLE = (band) => ['small', 'mid', 'large'].filter(b => BAND_RANK[b] <= BAND_RANK[band]);
    // Same-degree dedup tolerance: a non-extending BOS this close to the
    // prevailing anchor is a near-duplicate → emit as INVALIDATED (the user's
    // BOS-X, e.g. 41841 vs 41850). Anything further is just dropped as noise.
    const dedupFrac = Number(p.dedup_frac) || DEFAULT_PARAMS.dedup_frac;
    const out = [];
    const emit = (leg, band, type, state) => {
      out.push({
        type, direction: leg.dir,
        pivotBarIdx: leg.brokenBar,
        pivotTs:     dataList[leg.brokenBar] ? dataList[leg.brokenBar].timestamp : null,
        level:       leg.level,
        eventBarIdx: leg.breakBar,
        eventTs:     dataList[leg.breakBar] ? dataList[leg.breakBar].timestamp : null,
        span: leg.breakBar - leg.brokenBar, degree: band,
        state: state || 'valid',   // 'valid' (O) | 'invalidated' (X) — §4zt v2
        trendBefore: type === 'BOS' ? leg.dir : (leg.dir === 'up' ? 'down' : 'up'),
      });
      return out.length - 1;
    };
    // CROSS-TREND SWALLOW (rule A / Wister §6-2(11) 不連續): a confirmed BOS in
    // `dir` invalidates the OPPOSITE direction's running CHoCh across this band +
    // smaller ones whose level the move has traded back through, and resets that
    // opposite structure. Shared by both trend modes.
    const swallow = (dir, band, level) => {
      const opp = dir === 'up' ? 'down' : 'up';
      for (const b2 of bandsLE(band)) {
        const O = st[b2][opp];
        if (O.chochIdx != null) {
          const c = out[O.chochIdx];
          // §6-2(11) 不連續 / 鑲嵌: a CHoCh dies only when its PROTECTIVE origin
          // level is broken — a down-CHoCh when price trades back ABOVE the high it
          // fell from (c.protect), an up-CHoCh when price breaks BELOW its origin
          // low. Comparing against the broken pivot (c.level) instead over-fires
          // and kills nested structures the user keeps as O. Falls back to c.level
          // when protect is absent (backbone mode → unchanged behaviour).
          const ref = (c.protect != null) ? c.protect : c.level;
          const swallowed = dir === 'up' ? level > ref : level < ref;
          if (swallowed && c.state !== 'invalidated') c.state = 'invalidated';
        }
        O.chochIdx = null; O.anchor = null; O.chochEnd = -1;
      }
    };
    const extendsTo = (dir, level, ref) => ref == null || (dir === 'up' ? level > ref : level < ref);
    // Protective origin extreme of a CHoCh leg: the lowest low (up-CHoCh) / highest
    // high (down-CHoCh) across the leg's bar span — the level whose break makes the
    // structure 不連續 (§6-2(11)).
    const protectOf = (leg) => {
      const a = Math.min(leg.brokenBar, leg.breakBar), b = Math.max(leg.brokenBar, leg.breakBar);
      let v = leg.dir === 'up' ? Infinity : -Infinity;
      for (let k = a; k <= b; k++) { const bar = dataList[k]; if (!bar) continue; v = leg.dir === 'up' ? Math.min(v, bar.low) : Math.max(v, bar.high); }
      return Number.isFinite(v) ? v : leg.level;
    };

    if (mode === 'backbone') {
      // v1: trend from the N-wave skeleton; a leg WITH it = BOS, AGAINST = CHoCh.
      const backbone = _buildBackbone(dataList, p);
      const trendAt = (K) => {
        let tr = backbone.length ? backbone[0].trendBefore : null;
        for (const e of backbone) { if (e.eventBarIdx <= K) tr = e.direction; else break; }
        return tr;
      };
      for (const leg of legs) {
        const span = leg.breakBar - leg.brokenBar;
        if (span < minSpan) continue;
        const trend = trendAt(leg.breakBar);
        if (!trend || trend === 'unknown') continue;   // backbone hasn't resolved a trend yet
        const band = bandOf(span);
        const T = st[band][leg.dir];
        const type = (leg.dir === trend) ? 'BOS' : 'CHoCh';

        if (type === 'CHoCh') {
          T.chochIdx = emit(leg, band, 'CHoCh'); T.anchor = leg.level; T.chochEnd = leg.breakBar;
        } else {
          // start-rule: a BOS breaking a pivot predating this direction's CHoCh is
          // part of that CHoCh's impulse → absorb (extend it), don't emit a BOS.
          if (T.chochIdx != null && leg.brokenBar < T.chochEnd) {
            const c = out[T.chochIdx];
            const deeper = leg.dir === 'up' ? leg.level > c.level : leg.level < c.level;
            if (deeper) { c.level = leg.level; c.pivotBarIdx = leg.brokenBar; c.pivotTs = dataList[leg.brokenBar] ? dataList[leg.brokenBar].timestamp : null; }
            c.eventBarIdx = leg.breakBar; c.eventTs = dataList[leg.breakBar] ? dataList[leg.breakBar].timestamp : null;
            c.span = c.eventBarIdx - c.pivotBarIdx;
            T.anchor = c.level; T.chochEnd = c.eventBarIdx;
            continue;
          }
          // §1-1: a BOS must extend beyond the anchor. A non-extending BOS that
          // sits right on the anchor is a near-duplicate → INVALIDATED (BOS-X);
          // further-away ones are dropped as noise.
          if (T.anchor != null && !extendsTo(leg.dir, leg.level, T.anchor)) {
            const near = Math.abs(leg.level - T.anchor) <= Math.abs(T.anchor) * dedupFrac;
            if (near) emit(leg, band, 'BOS', 'invalidated');
            continue;
          }
          emit(leg, band, 'BOS'); T.anchor = leg.level;
          swallow(leg.dir, band, leg.level);
        }
      }
    } else {

    // ---- 'flip' mode: trend evolves from the legs, flips on each genuine CHoCh ----
    // For each band, keep an evolving `trend` + a persisting per-direction anchor
    // (the extreme that direction's structure has reached — NOT reset by a counter
    // CHoCh, so a later re-extension is recognised as a confirming BOS). Rules:
    //   • with-trend leg → BOS if it extends the anchor (else near-dup X / drop)
    //   • counter leg that RE-EXTENDS a prior same-dir anchor → confirming BOS:
    //     flip trend + swallow the opposite warning CHoCh (e.g. 41603 up confirms,
    //     kills the down CHoCh 41384)
    //   • counter leg that breaks fresh ground → a new CHoCh: flip trend (the
    //     "real CHoCh flips" rule), but stays a provisional O until either a BOS
    //     confirms it or the old trend's BOS swallows it into X.
    for (const leg of legs) {
      const span = leg.breakBar - leg.brokenBar;
      if (span < minSpan) continue;
      const band = bandOf(span);
      const B = st[band];
      const d = leg.dir;
      const T = B[d];

      if (B.trend == null) { B.trend = d; emit(leg, band, 'BOS'); T.anchor = leg.level; continue; }

      if (d === B.trend) {
        if (extendsTo(d, leg.level, T.anchor)) {
          emit(leg, band, 'BOS'); T.anchor = leg.level; swallow(d, band, leg.level);
        } else {
          const near = T.anchor != null && Math.abs(leg.level - T.anchor) <= Math.abs(T.anchor) * dedupFrac;
          if (near) emit(leg, band, 'BOS', 'invalidated');
        }
      } else {
        if (T.anchor != null && extendsTo(d, leg.level, T.anchor)) {
          // counter move re-extends a prior same-dir structure → confirming BOS
          emit(leg, band, 'BOS'); T.anchor = leg.level; B.trend = d; swallow(d, band, leg.level);
        } else {
          // fresh counter break → a genuine CHoCh; flip trend (provisional O)
          T.chochIdx = emit(leg, band, 'CHoCh'); out[T.chochIdx].protect = protectOf(leg);
          T.anchor = leg.level; T.chochEnd = leg.breakBar; B.trend = d;
        }
      }
    }
    }

    // ---- Stage-1 near-dup recovery: surface the losers as invalidated (X) ----
    // A near-dup loser is a pivot taken out by the SAME break bar as an emitted
    // event, within dedup_frac of it. Emit it as an invalidated sibling that
    // inherits the primary event's type (e.g. BOS-O 41850 → its loser 41841 prints
    // BOS-X). Tied to a real emission so it can't flood with phantom structure.
    // FLIP-ONLY: backbone is the legacy default and its coarser primaries spawn
    // noisy losers (mostly spurious X), so we keep that path unchanged.
    if (mode === 'flip') for (const L of nearDupLosers) {
      const span = L.breakBar - L.brokenBar;
      if (span < minSpan) continue;
      const primary = out.find(e => e.direction === L.dir && Math.abs(e.eventBarIdx - L.breakBar) <= 1
        && Math.abs(e.level - L.level) <= Math.abs(L.level) * dupFrac && e.state !== 'invalidated');
      if (!primary) continue;
      if (out.some(e => e.direction === L.dir && e.pivotBarIdx === L.brokenBar && e.eventBarIdx === L.breakBar)) continue;
      out.push({
        type: primary.type, direction: L.dir,
        pivotBarIdx: L.brokenBar, pivotTs: dataList[L.brokenBar] ? dataList[L.brokenBar].timestamp : null,
        level: L.level,
        eventBarIdx: L.breakBar, eventTs: dataList[L.breakBar] ? dataList[L.breakBar].timestamp : null,
        span, degree: bandOf(span), state: 'invalidated',
        trendBefore: primary.trendBefore,
      });
    }
    return out;
  }

  // Build the N-wave swing skeleton → bos_choch events (the clean trend backbone).
  // Returns [] (→ no trend) if the deps aren't loaded. Sorted by eventBarIdx.
  function _buildBackbone(dataList, p) {
    const N   = (typeof window !== 'undefined') && window.NWaveIndicator;
    const BCD = (typeof window !== 'undefined') && window.BOSChoChDetector;
    if (!N || !BCD || typeof N.detectAlternatingSequence !== 'function'
        || typeof N.applyAmplitudeFilter !== 'function' || typeof BCD.detectEventsFromSeq !== 'function') {
      return [];
    }
    const str = Math.max(1, p.backbone_strength | 0);
    const minSw = Number(p.backbone_min_swing) || 0;
    let seq = N.detectAlternatingSequence(dataList, str, str);
    seq = N.applyAmplitudeFilter(seq, minSw, 'absolute');
    const evs = BCD.detectEventsFromSeq(seq, dataList, {
      left_strength: str, right_strength: str, min_swing_amount: minSw, swing_unit: 'absolute',
      require_close_break: !!p.require_close_break, enforce_choch_below_bos: true,
    });
    return evs.slice().sort((a, b) => a.eventBarIdx - b.eventBarIdx);
  }

  // ===========================================================================
  // Rendering
  // ===========================================================================

  function _withAlpha(hex, alpha) {
    if (!hex) return `rgba(0,0,0,${alpha})`;
    if (hex.startsWith('#') && hex.length === 7) {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    return hex;
  }
  const _degAlpha = d => d === 'large' ? 1.0 : d === 'mid' ? 0.85 : 0.5;
  const _degWidth = d => d === 'large' ? 3   : d === 'mid' ? 2    : 1;

  function _drawEvent(ctx, ev, ext, xAxis, yAxis) {
    // Colour = direction (bull green / bear red). Line style = type (BOS solid /
    // CHoCh dashed). So a bearish BOS draws as a solid RED line, not green.
    const color = ev.direction === 'up' ? (ext.bull_color || DEFAULT_PARAMS.bull_color)
                                        : (ext.bear_color || DEFAULT_PARAMS.bear_color);
    const lblColor = ext.label_color || DEFAULT_PARAMS.label_color;
    const fontSize = Number(ext.marker_text_size) || DEFAULT_PARAMS.marker_text_size;
    const dashed   = ev.type === 'CHoCh';
    // §4zt v2: invalidated (失效 / X) events draw faded, the label gets an " X "
    // marker, and the line is struck through so it reads as a dead structure.
    const invalid  = ev.state === 'invalidated';

    const y = yAxis.convertToPixel(ev.level);
    const xPivot = xAxis.convertToPixel(ev.pivotBarIdx);
    const xEvent = xAxis.convertToPixel(ev.eventBarIdx);
    if (![y, xPivot, xEvent].every(Number.isFinite)) return;

    const base = (ext.show_span_in_label !== false)
      ? `${ev.type === 'BOS' ? 'BOS' : 'CHOCH'} ${ev.span}`
      : (ev.type === 'BOS' ? 'BOS' : 'CHOCH');
    const label = invalid ? `${base} ✕` : base;
    const centerX = (xPivot + xEvent) / 2;

    ctx.save();
    ctx.font = `bold italic ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const halfGap = ctx.measureText(label).width / 2 + 8;

    const alpha = _degAlpha(ev.degree) * (invalid ? 0.4 : 1);
    ctx.strokeStyle = _withAlpha(color, alpha);
    ctx.lineWidth = _degWidth(ev.degree);
    ctx.setLineDash(invalid ? [2, 3] : (dashed ? [6, 4] : []));
    // line in two segments, leaving a gap for the centered label
    const segs = [[xPivot, centerX - halfGap], [centerX + halfGap, xEvent]];
    for (const [a, b] of segs) {
      if (a < b) { ctx.beginPath(); ctx.moveTo(a, y); ctx.lineTo(b, y); ctx.stroke(); }
    }
    ctx.setLineDash([]);

    ctx.fillStyle = invalid ? _withAlpha(lblColor, 0.55) : lblColor;
    ctx.fillText(label, centerX, y);
    ctx.restore();
  }

  function _shownByDegree(ext, deg) {
    if (deg === 'large') return ext.show_large !== false;
    if (deg === 'mid')   return ext.show_mid   !== false;
    return ext.show_small !== false;
  }

  // ===========================================================================
  // KLineChart template + registration plumbing (mirrors bos_choch.js)
  // ===========================================================================

  function _paramsToExtend(p) {
    return { ...DEFAULT_PARAMS, ...p };
  }
  function _paramsToCalc(p) {
    return [
      !!p.require_close_break, p.min_span, p.min_swing_amount,
      p.degree_mid_min, p.degree_large_min, p.max_span,
      p.backbone_strength, p.backbone_min_swing, p.dedup_frac, p.trend_mode,
    ];
  }

  function _buildKlineTemplate() {
    return {
      name: KLC_NAME,
      shortName: 'Span Structure',
      calcParams: _paramsToCalc(DEFAULT_PARAMS),
      extendData: _paramsToExtend(DEFAULT_PARAMS),
      styles: { tooltip: { showRule: 'none' } },
      calc(dataList, indicator) {
        const cp  = (indicator && indicator.calcParams) || [];
        const ext = (indicator && indicator.extendData) || {};
        const params = {
          require_close_break: cp[0] !== undefined ? cp[0] : (ext.require_close_break === true),
          min_span:            cp[1] ?? ext.min_span         ?? DEFAULT_PARAMS.min_span,
          min_swing_amount:    cp[2] ?? ext.min_swing_amount ?? DEFAULT_PARAMS.min_swing_amount,
          degree_mid_min:      cp[3] ?? ext.degree_mid_min   ?? DEFAULT_PARAMS.degree_mid_min,
          degree_large_min:    cp[4] ?? ext.degree_large_min ?? DEFAULT_PARAMS.degree_large_min,
          max_span:            cp[5] ?? ext.max_span         ?? DEFAULT_PARAMS.max_span,
          backbone_strength:   cp[6] ?? ext.backbone_strength  ?? DEFAULT_PARAMS.backbone_strength,
          backbone_min_swing:  cp[7] ?? ext.backbone_min_swing ?? DEFAULT_PARAMS.backbone_min_swing,
          dedup_frac:          cp[8] ?? ext.dedup_frac         ?? DEFAULT_PARAMS.dedup_frac,
          trend_mode:          cp[9] ?? ext.trend_mode         ?? DEFAULT_PARAMS.trend_mode,
        };
        const events = detectSpanEvents(dataList, params);
        _eventsByPaneKey.set(_paneKey(indicator && indicator.paneId), events);
        const out = new Array(dataList.length).fill(null);
        if (out.length > 0) out[0] = { events };
        return out;
      },
      draw({ ctx, kLineDataList, indicator, visibleRange, xAxis, yAxis }) {
        const ext = (indicator && indicator.extendData) || {};
        if (ext.hidden === true) return false;
        const result = indicator && indicator.result;
        if (!Array.isArray(result) || !result.length) return false;
        const events = (result[0] && result[0].events) || [];
        if (!events.length) return false;

        const from = visibleRange && visibleRange.realFrom != null ? visibleRange.realFrom : (visibleRange ? visibleRange.from : 0);
        const to   = visibleRange && visibleRange.realTo   != null ? visibleRange.realTo   : (visibleRange ? visibleRange.to   : kLineDataList.length - 1);
        for (const ev of events) {
          if (!_shownByDegree(ext, ev.degree)) continue;
          if (ev.pivotBarIdx > to + 2) continue;
          if (ev.eventBarIdx < from - 2) continue;
          _drawEvent(ctx, ev, ext, xAxis, yAxis);
        }
        return false;
      },
    };
  }

  function add(chart, params) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    return chart.createIndicator({
      name: KLC_NAME, calcParams: _paramsToCalc(p), extendData: _paramsToExtend(p),
    }, true, { id: 'candle_pane' });
  }
  function remove(chart, paneId) {
    try { chart.removeIndicator({ name: KLC_NAME }, paneId || 'candle_pane'); } catch (e) { /* ignore */ }
    _eventsByPaneKey.delete(_paneKey(paneId));
  }
  function applyParams(chart, paneId, params, visible) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    const ext = _paramsToExtend(p);
    if (visible === false) ext.hidden = true;
    try {
      chart.overrideIndicator({ name: KLC_NAME, calcParams: _paramsToCalc(p), extendData: ext }, paneId || 'candle_pane');
    } catch (e) { /* ignore */ }
  }
  function getEventsForChart(_chart, paneId) {
    return _eventsByPaneKey.get(_paneKey(paneId)) || [];
  }

  window.SpanStructure = {
    type:          TYPE_NAME,
    name:          'Span Structure（CHoCh/BOS · 級別）',
    defaultParams: { ...DEFAULT_PARAMS },
    paramSchema:   PARAM_SCHEMA,
    klineTemplate: _buildKlineTemplate(),
    add, remove, applyParams,
    // pure functions for tests / downstream:
    detectSpanEvents,
    degreeOf,
    getEventsForChart,
  };
})();
