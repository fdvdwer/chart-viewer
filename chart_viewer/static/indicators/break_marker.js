/* ============================================================================
 * break_marker.js — port of Wister's MC "Span/BreakMarker" structure engine
 * ============================================================================
 * Faithful JS port of `_Wister_Span_v0.06(多空頭實現).el` (MultiCharts /
 * PowerLanguage). Detects market-structure events (CHoCH / BOS / terminator)
 * on BOTH sides from an alternating swing-pivot stream, using span (create→break
 * bar distance) as the degree proxy. Spec: docs/specs/BreakMarker_hiStatus_SPEC.md.
 *
 * WHY a port: chart_viewer's own bos_choch / span_structure detectors classify
 * with a trend state machine; this engine instead grows structure *emergently*
 * from near-pairing + a 2x span gate + per-chain ceiling demotion + terminator
 * sealing + log2 levels + source protection. The user validated it on MC (TXF1
 * 15Min) and wants it driving the supply/demand zones for sharper anchors.
 *
 * FIDELITY NOTES (differences from the v0.06 .el, on purpose):
 *   1. LOW-SIDE SCAN C seal direction — the .el seals `loPrice < xPrice` (a
 *      copy-paste from the high side); the intent (and its own qualify-loop +
 *      comment) is to seal HIGHER lows, so here it seals `price > xPrice`.
 *      → Flagged to the user to fix in MC too.
 *   2. Pivot source — the .el consumes `_Wister_SwingPivot`; here the engine
 *      takes an externally supplied alternating pivot sequence (n_wave's
 *      detectAlternatingSequence by default) so it is unit-testable and the
 *      pivot definition can later be aligned bit-for-bit with MC.
 *
 * Pure core (`detect`) has NO DOM / chart access → node-testable.
 *   window.BreakMarker.detect(dataList, pivotSeq, params) → { hi, lo, log }
 * ========================================================================== */
(function () {
  const TYPE_NAME = 'break_marker';

  const ST_EMPTY = 0, ST_ALIVE = 1, ST_CHOCH = 2, ST_CLOSED = 3;

  const DEFAULT_PARAMS = {
    // ---- pivot feed ----
    pivot_source:   'swing',   // 'swing' = _Wister_SwingPivot (MC) | 'nwave' = fractal L/R
    add_span:       false,     // §14: also feed span sub-pivots (finer L0–L2 micro-structure)
    left_strength:  3,         // (nwave mode only)
    right_strength: 3,         // (nwave mode only)
    min_swing_amount: 0,
    swing_unit:     'absolute',
    // ---- engine ----
    span_ratio_lo:  0.5,   // BOS span must be >= CHoCH span * this
    span_ratio_hi:  2.0,   // BOS span must be <= CHoCH span * this
    min_break_gap:  2,     // a level can't break within this many bars of forming
    // ---- display ----
    show_hi:        true,
    show_lo:        true,
    show_closed:    true,  // draw sealed (CLOSED) lines dimmed
    show_label:     false, // span number on the line
    show_zones:     false, // also draw supply/demand zones from this structure
  };

  // MC colours (from _Wister_Span_v0.06 `once` block): bull(up)=blue, bear(down)
  // =orange; BOS lighter than CHoCH; sealed=dim.
  const COL = {
    hi: { choch: 'rgb(70,160,255)', chochDim: 'rgb(28,70,120)', bos: 'rgb(120,180,235)', bosDim: 'rgb(45,70,100)' },
    lo: { choch: 'rgb(255,150,45)', chochDim: 'rgb(120,68,18)', bos: 'rgb(225,170,120)', bosDim: 'rgb(100,68,40)' },
  };

  const SWING_UNIT_OPTIONS = [
    { value: 'absolute', label: '價格點' },
    { value: 'pct',      label: '百分比 %' },
  ];

  const PIVOT_SOURCE_OPTIONS = [
    { value: 'swing', label: 'Swing Pivot（MC 一致）' },
    { value: 'nwave', label: 'NWave fractal（L/R）' },
  ];

  const PARAM_SCHEMA = [
    { type: 'section', label: 'Pivot 來源' },
    { key: 'pivot_source',     label: 'Pivot 演算法',   type: 'enum',   options: PIVOT_SOURCE_OPTIONS, default: 'swing' },
    { key: 'add_span',         label: '加入 span 子樞紐（微結構）', type: 'bool', default: false },
    { key: 'left_strength',    label: 'LeftStrength（僅 nwave）',  type: 'int',    min: 1, max: 50, default: 3 },
    { key: 'right_strength',   label: 'RightStrength（僅 nwave）', type: 'int',    min: 1, max: 50, default: 3 },
    { key: 'min_swing_amount', label: '最小擺動（濾波）', type: 'number', min: 0,          default: 0 },
    { key: 'swing_unit',       label: '單位',           type: 'enum',   options: SWING_UNIT_OPTIONS, default: 'absolute' },

    { type: 'section', label: '結構引擎（span 級別）' },
    { key: 'span_ratio_lo', label: 'BOS span 下限（×Y）', type: 'number', min: 0.1, max: 1,   default: 0.5 },
    { key: 'span_ratio_hi', label: 'BOS span 上限（×Y）', type: 'number', min: 1,   max: 10,  default: 2.0 },
    { key: 'min_break_gap', label: '最小破口間隔（根）',   type: 'int',    min: 1,   max: 20,  default: 2 },

    { type: 'section', label: '顯示' },
    { key: 'show_hi',     label: '顯示 高側（多頭·藍）', type: 'bool', default: true },
    { key: 'show_lo',     label: '顯示 低側（空頭·橙）', type: 'bool', default: true },
    { key: 'show_closed', label: '顯示 已封印（淡）',     type: 'bool', default: true },
    { key: 'show_label',  label: 'Label 顯示 span',      type: 'bool', default: false },

    { type: 'section', label: '供需區' },
    { key: 'show_zones',  label: '顯示供需區（依此結構）', type: 'bool', default: false },
  ];

  const _level = (span) => (span >= 1 ? Math.floor(Math.log(span) / Math.log(2)) : 0);

  // ===========================================================================
  // _Wister_SwingPivot — faithful port of the MC base pivot function.
  // A directional state machine over one-bar signals (upSig = H>H[1],
  // dnSig = L<L[1]). While looking for a high it tracks the running highest
  // high; the FIRST bar that prints a lower low confirms that high as a swing
  // pivot (and flips to looking for a low). Mirror for lows. Output alternates
  // high/low by construction. A pivot is dated at its extreme bar (barIdx) but
  // only KNOWN at the confirming bar (confirmBar) — a variable lag, NOT a fixed
  // fractal R. The final unconfirmed candidate is intentionally NOT emitted (no
  // lookahead). This is what the user's BOS/CHoCh (BreakMarker) actually feeds on.
  // ===========================================================================
  // opts.add_span (§14): also emit span sub-pivots — minor 3-bar tips the main
  // pivot misses, on the CURRENT bar with the tip at CurrentBar-1. They ride in
  // the SAME output stream (type 'high'/'low', flagged isSpan) since the engine
  // judges every point by dt/price/level, not by push order or kind.
  function swingPivots(dataList, opts) {
    const out = [];
    if (!Array.isArray(dataList)) return out;
    const addSpan = !!(opts && opts.add_span);
    let lookingFor = 0, candPrice = 0, candBar = 0;
    let hpcPrev = false, lpcPrev = false;   // HighPivotCond[1] / LowPivotCond[1]
    for (let K = 0; K < dataList.length; K++) {
      const bar = dataList[K];
      if (!bar) continue;
      if (bar._placeholder) break;   // replay safety
      const prev = dataList[K - 1];
      const upSig = prev ? (bar.high > prev.high) : false;   // H > H[1]
      const dnSig = prev ? (bar.low  < prev.low)  : false;   // L < L[1]

      // ---- MAIN pivot state machine (unchanged) ----
      if (lookingFor === 0) {
        if (upSig)      { lookingFor = 1;  candPrice = bar.high; candBar = K; }
        else if (dnSig) { lookingFor = -1; candPrice = bar.low;  candBar = K; }
      } else if (lookingFor === 1) {
        if (upSig && bar.high >= candPrice) { candPrice = bar.high; candBar = K; }   // extend the high
        if (dnSig) {                                                                 // confirm the high
          out.push({ barIdx: candBar, price: candPrice, type: 'high', confirmBar: K });
          lookingFor = -1; candPrice = bar.low; candBar = K;
        }
      } else { // lookingFor === -1
        if (dnSig && bar.low <= candPrice) { candPrice = bar.low; candBar = K; }     // extend the low
        if (upSig) {                                                                 // confirm the low
          out.push({ barIdx: candBar, price: candPrice, type: 'low', confirmBar: K });
          lookingFor = 1; candPrice = bar.high; candBar = K;
        }
      }

      // ---- SPAN sub-pivot detector (independent; runs AFTER the main SM so the
      // pivot-priority guard sees the updated candidate). Mirrors the EL exactly.
      if (addSpan && K >= 2) {
        const b1 = dataList[K - 1], b2 = dataList[K - 2];
        if (b1 && b2 && !b1._placeholder && !b2._placeholder) {
          const spanHi = (b2.high > b1.high) && (b1.high > bar.high) &&
                         (b1.high > b1.open) && (b1.high > b1.close) && (hpcPrev === false);
          const spanLo = (b2.low < b1.low) && (b1.low < bar.low) &&
                         (b1.low < b1.open) && (b1.low < b1.close) && (lpcPrev === false);
          if (spanHi) {
            if (!(lookingFor === 1 && b1.high === candPrice && (K - 1) === candBar))
              out.push({ barIdx: K - 1, price: b1.high, type: 'high', confirmBar: K, isSpan: true });
          } else if (spanLo) {
            if (!(lookingFor === -1 && b1.low === candPrice && (K - 1) === candBar))
              out.push({ barIdx: K - 1, price: b1.low, type: 'low', confirmBar: K, isSpan: true });
          }
        }
      }
      // HighPivotCond / LowPivotCond for the NEXT bar's [1] reference.
      hpcPrev = upSig || (prev ? (bar.low  > prev.low)  : false);
      lpcPrev = dnSig || (prev ? (bar.high < prev.high) : false);
    }
    return out;
  }

  /**
   * Run the engine over bars + an alternating pivot sequence.
   * @param {Array} dataList  bars [{timestamp, open, high, low, close}, ...]
   * @param {Array} pivotSeq  alternating pivots [{barIdx, price, type:'high'|'low'}]
   * @param {Object} params
   * @returns {{hi: Array, lo: Array, log: Array}}  final ledgers + event log
   */
  function detect(dataList, pivotSeq, params) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    if (!Array.isArray(dataList) || !dataList.length) return { hi: [], lo: [], log: [] };
    if (!Array.isArray(pivotSeq)) pivotSeq = [];

    const R = p.right_strength | 0;
    const LO = Number(p.span_ratio_lo), HI = Number(p.span_ratio_hi);
    const gap = p.min_break_gap | 0;

    // Each side's ledger is a plain growing array (JS has no CAP wraparound;
    // identity is still by `dt` (= pivot timestamp) to mirror the .el's
    // dt-keyed chainRoot / BOS-source matching).
    const hi = [], lo = [];
    const log = [];

    // Pivots become active at their confirmBar (the bar `_Wister_SwingPivot`
    // confirms them — a VARIABLE lag, when the opposite one-bar signal fires).
    // A pivot may carry an explicit confirmBar; else fall back to barIdx + R
    // (used by unit tests that feed hand-built pivots without a confirm bar).
    const pending = pivotSeq
      .filter(pv => pv && (pv.type === 'high' || pv.type === 'low'))
      .map(pv => ({ ...pv, confirmBar: pv.confirmBar != null ? pv.confirmBar : pv.barIdx + R }))
      .sort((a, b) => a.confirmBar - b.confirmBar);
    let pi = 0;

    // ---- side descriptor: sign +1 = high (break up), -1 = low (break down) ----
    const sides = {
      hi: { led: hi, sign: +1 },
      lo: { led: lo, sign: -1 },
    };
    // "a is further in the break direction than b"
    const moreExt = (sign, a, b) => sign > 0 ? a > b : a < b;
    const atLeast = (sign, a, b) => sign > 0 ? a >= b : a <= b;

    const n = dataList.length;
    for (let K = 0; K < n; K++) {
      const bar = dataList[K];
      if (!bar || bar._placeholder) break;   // replay safety

      // reset per-bar transient flags across BOTH ledgers
      for (const e of hi) { e.justBroke = false; e.becameBOS = false; e.bosScanned = false; }
      for (const e of lo) { e.justBroke = false; e.becameBOS = false; e.bosScanned = false; }

      // (1) push any pivots confirmed at this bar
      while (pi < pending.length && pending[pi].confirmBar <= K) {
        const pv = pending[pi]; pi++;
        const led = pv.type === 'high' ? hi : lo;
        const dt = dataList[pv.barIdx] ? dataList[pv.barIdx].timestamp : pv.barIdx;
        led.push({
          side: pv.type === 'high' ? 'hi' : 'lo',
          price: pv.price, bar: pv.barIdx, dt,
          status: ST_ALIVE,
          isBOS: false, isConfirmed: false, isTerminator: false,
          justBroke: false, becameBOS: false, bosScanned: false,
          bosSrcDt: 0, bosSrcPrice: 0,
          chainRoot: dt,          // starts as its own root
          chainExt: pv.price,     // root ceiling(hi)/floor(lo) = own price
          span: 0,
          isSpan: !!pv.isSpan,    // §14: came from a span sub-pivot (finer tip)
        });
      }

      // (2) run the three scans for hi, then lo (order mirrors the .el)
      _runScans(sides.hi, K, bar, LO, HI, gap, moreExt, atLeast, log);
      _runScans(sides.lo, K, bar, LO, HI, gap, moreExt, atLeast, log);
    }

    return { hi, lo, log };
  }

  // One side's SCAN A + B + C for the current bar.
  function _runScans(side, K, bar, LO, HI, gap, moreExt, atLeast, log) {
    const { led, sign } = side;
    const dtStr = (dt) => (typeof dt === 'number' && dt > 1e11) ? new Date(dt).toISOString().slice(0, 16) : String(dt);
    const findByDt = (dt) => { for (const e of led) if (e.dt === dt) return e; return null; };

    // ============ SCAN A — break-mark (+ same-price MERGE) ============
    for (const e of led) {
      if (e.status !== ST_ALIVE) continue;
      if (K - e.bar < gap) continue;
      const broke = sign > 0 ? (bar.high >= e.price) : (bar.low <= e.price);
      if (!broke) continue;

      const newSpan = K - e.bar;

      // ---- same-price MERGE: an earlier same-price CHoCH whose span ratio vs
      // this break is OUT of band = same structural level touched at a different
      // degree → fold into the older one. Pick the EARLIEST such. ----
      let merge = null;
      for (const o of led) {
        if (o === e) continue;
        if (o.status !== ST_CHOCH) continue;
        if (o.price !== e.price) continue;          // exact same price
        if (!(o.dt < e.dt)) continue;               // older
        if (o.isConfirmed) continue;                // not yet broken beyond
        const outOfBand = (newSpan < o.span * LO) || (newSpan > o.span * HI);
        if (!outOfBand) continue;
        if (!merge || o.dt < merge.dt) merge = o;   // earliest
      }

      // ---- MERGE VETO: if a more-extreme point ever appeared AFTER the target,
      // the structure already broke past this level → it is void, don't merge. ----
      if (merge) {
        for (const o of led) {
          if (o === merge || o === e) continue;
          if (o.status === ST_EMPTY) continue;
          if (moreExt(sign, o.price, merge.price) && o.dt > merge.dt) { merge = null; break; }
        }
      }

      if (merge) {
        // fold e into merge; e retires
        e.status = ST_CLOSED;
        merge.span = K - merge.bar;                 // survivor span = old start → this break
        log.push(`MERGE | new(${dtStr(e.dt)} ${e.price}) -> older(${dtStr(merge.dt)}) newSpan=${merge.span} keep=${merge.isBOS ? 'BOS' : 'CHoCH'}`);
        // merged super-CHoCH acts as a terminator: seal all less-extreme CHoCH
        // (log2-level source protection applies).
        merge.isTerminator = true;
        _seal(led, merge, /*killerSpan*/ merge.span, sign, moreExt, /*bosExcept*/ null);
      } else {
        // normal break: ALIVE → CHoCH
        e.status = ST_CHOCH;
        e.justBroke = true;
        e.span = newSpan;
        log.push(`BREAK | pt(${dtStr(e.dt)} ${e.price}) createBar=${e.bar} breakBar=${K} span=${newSpan}`);
      }
    }

    // ============ SCAN B — BOS pairing (least-extreme first) ============
    // Process just-broke CHoCH from least-extreme to most-extreme so a nearer
    // break pairs + moves the chain ceiling before a further one is judged.
    while (true) {
      let pick = null;
      for (const e of led) {
        if (!(e.justBroke && !e.bosScanned && e.status === ST_CHOCH)) continue;
        // least-extreme = smallest for hi / largest for lo
        if (!pick || moreExt(sign, pick.price, e.price)) pick = e;
      }
      if (!pick) break;
      pick.bosScanned = true;

      const xDt = pick.dt, xPrice = pick.price;
      // find Y = earlier + less-extreme + span-fit CHoCH, latest dt
      let Y = null;
      for (const o of led) {
        if (o.status !== ST_CHOCH) continue;
        if (!(o.dt < xDt)) continue;
        if (!moreExt(sign, xPrice, o.price)) continue;          // X strictly beyond Y
        if (!(pick.span >= o.span * LO && pick.span <= o.span * HI)) continue;   // span fit
        if (!Y || o.dt > Y.dt) Y = o;
      }

      if (!Y) {
        log.push(`CHoCH(no-span-match) | X(${dtStr(xDt)} ${xPrice}) span=${pick.span}`);
        continue;
      }

      // resolve Y's chain root + that chain's ceiling/floor
      const root = findByDt(Y.chainRoot);
      const chainCeil = root ? root.chainExt : Y.price;
      let ceilOK;
      if (root && chainCeil === root.price) ceilOK = atLeast(sign, xPrice, chainCeil);  // first BOS: >=/<=
      else ceilOK = moreExt(sign, xPrice, chainCeil);                                    // later BOS: strict

      if (ceilOK) {
        pick.isBOS = true;
        pick.becameBOS = true;
        pick.bosSrcDt = Y.dt;
        pick.bosSrcPrice = Y.price;
        Y.isConfirmed = true;
        pick.chainRoot = Y.chainRoot;
        if (root) root.chainExt = xPrice;   // extend the chain ceiling/floor
        log.push(`BOS | X(${dtStr(xDt)} ${xPrice}) confirms Y(${dtStr(Y.dt)} ${Y.price}) [ceil ${chainCeil}] Xspan=${pick.span} Yspan=${Y.span}`);
      } else {
        log.push(`CHoCH(demoted-ceil) | X(${dtStr(xDt)} ${xPrice}) vs ceil ${chainCeil} -> stays CHoCH`);
      }
    }

    // ============ SCAN C — terminator sealing ============
    for (const e of led) {
      if (!(e.justBroke && e.status === ST_CHOCH)) continue;
      const xDt = e.dt, xPrice = e.price;
      // qualifies as terminator iff a LATER + less-extreme CHoCH exists (the floor)
      let floor = null;
      for (const o of led) {
        if (o.status !== ST_CHOCH) continue;
        if (!(o.dt > xDt)) continue;                 // created later
        if (!moreExt(sign, xPrice, o.price)) continue;   // less extreme than X
        // floor = the most-away one (lowest for hi / highest for lo)
        if (!floor || moreExt(sign, floor.price, o.price)) floor = o;
      }
      if (!floor) continue;
      e.isTerminator = true;
      _seal(led, e, /*killerSpan*/ e.span, sign, moreExt, /*bosExcept*/ { dt: e.bosSrcDt, price: e.bosSrcPrice });
      log.push(`TERMINATOR | X(${dtStr(xDt)} ${xPrice}) floor=(${dtStr(floor.dt)} ${floor.price}) -> sealed less-extreme CHoCH`);
    }
  }

  // Close every CHoCH less-extreme than `killer`, except the killer, its BOS
  // source (if given), and a log2-level-PROTECTED source (a terminator of
  // strictly higher level out-ranks the killer and survives).
  function _seal(led, killer, killerSpan, sign, moreExt, bosExcept) {
    const lvlKiller = _level(killerSpan);
    for (const o of led) {
      if (o === killer) continue;
      if (o.status !== ST_CHOCH) continue;
      if (!moreExt(sign, killer.price, o.price)) continue;   // must be less extreme than killer
      if (bosExcept && o.dt === bosExcept.dt && o.price === bosExcept.price) continue;
      let protectedSrc = false;
      if (o.isTerminator && _level(o.span) > lvlKiller) protectedSrc = true;
      if (protectedSrc) continue;
      o.status = ST_CLOSED;
    }
  }

  // ===========================================================================
  // Adapter → supply/demand zone events. Converts the {hi, lo} ledger into the
  // event shape SupplyDemandZones consumes (type/direction/pivot/level/eventBar +
  // an OB origin pivot), carrying break_marker metadata (log2 level, sealed,
  // terminator, BOS) so the zone layer can filter on structure quality.
  //   hi entry (up-break) → demand ; lo entry (down-break) → supply.
  //   obPivot = the most-recent OPPOSITE swing pivot before the break (the
  //   pullback low/high the order block sits on).
  // ===========================================================================
  function toZoneEvents(res, pivotSeq, dataList) {
    const events = [];
    const lows  = (pivotSeq || []).filter(p => p.type === 'low').sort((a, b) => a.barIdx - b.barIdx);
    const highs = (pivotSeq || []).filter(p => p.type === 'high').sort((a, b) => a.barIdx - b.barIdx);
    const recentOpp = (arr, beforeBar) => {
      let best = null;
      for (const p of arr) { if (p.barIdx < beforeBar) best = p; else break; }
      return best;
    };
    const conv = (e, dir) => {
      if (e.status !== ST_CHOCH && e.status !== ST_CLOSED) return;   // only broken levels
      if (e.span <= 0) return;                                        // retired merge latecomer
      const eventBarIdx = e.bar + e.span;
      const opp = dir === 'up' ? recentOpp(lows, eventBarIdx) : recentOpp(highs, eventBarIdx);
      events.push({
        type:          e.isBOS ? 'BOS' : 'CHoCh',
        direction:     dir,
        pivotBarIdx:   e.bar,
        pivotTs:       dataList[e.bar] ? dataList[e.bar].timestamp : null,
        level:         e.price,
        eventBarIdx,
        eventTs:       dataList[eventBarIdx] ? dataList[eventBarIdx].timestamp : null,
        obPivotBarIdx: opp ? opp.barIdx : null,
        obPivotPrice:  opp ? opp.price  : null,
        // break_marker structure metadata
        bmLevel:      _level(e.span),
        bmSealed:     e.status === ST_CLOSED,
        bmTerminator: e.isTerminator,
        bmBOS:        e.isBOS,
        bmSpan:       !!e.isSpan,
        span:         e.span,
        // the structure LINE colour (bull blue / bear orange, BOS lighter) so a
        // downstream consumer (S/D event line + label) can match it.
        bmColor:      _entryColor(e.side, e.isBOS, e.status === ST_CLOSED),
      });
    };
    for (const e of (res.hi || [])) conv(e, 'up');
    for (const e of (res.lo || [])) conv(e, 'down');
    events.sort((a, b) => a.eventBarIdx - b.eventBarIdx);
    return events;
  }

  // ===========================================================================
  // Pivot feed — NWave alternating sequence (same dep as span_structure)
  // ===========================================================================
  function _buildPivots(dataList, p) {
    const N = (typeof window !== 'undefined') && window.NWaveIndicator;
    let seq;
    if (p.pivot_source === 'nwave' && N && typeof N.detectAlternatingSequence === 'function') {
      // fractal L/R pivots (for side-by-side comparison; NOT what MC uses)
      seq = N.detectAlternatingSequence(dataList, p.left_strength | 0, p.right_strength | 0);
    } else {
      // MC-faithful: _Wister_SwingPivot (default), optionally + span sub-pivots
      seq = swingPivots(dataList, { add_span: !!p.add_span });
    }
    if (N && typeof N.applyAmplitudeFilter === 'function' && (Number(p.min_swing_amount) || 0) > 0) {
      seq = N.applyAmplitudeFilter(seq, Number(p.min_swing_amount), p.swing_unit || 'absolute');
    }
    return seq;   // [{barIdx, price, type, confirmBar?}]
  }

  // ===========================================================================
  // Rendering
  // ===========================================================================
  function _entryColor(side, isBOS, dim) {
    const c = COL[side] || COL.hi;
    if (isBOS) return dim ? c.bosDim : c.bos;
    return dim ? c.chochDim : c.choch;
  }

  // Draw one broken ledger entry as a horizontal level line pivot→break.
  function _drawEntry(ctx, e, ext, xAxis, yAxis) {
    if (e.status !== ST_CHOCH && e.status !== ST_CLOSED) return;   // only broken levels have a line
    if (e.span <= 0) return;                                        // retired merge latecomer
    const dim = e.status === ST_CLOSED;
    if (dim && ext.show_closed === false) return;
    const color = _entryColor(e.side, e.isBOS, dim);
    const y  = yAxis.convertToPixel(e.price);
    const x1 = xAxis.convertToPixel(e.bar);
    const x2 = xAxis.convertToPixel(e.bar + e.span);
    if (![y, x1, x2].every(Number.isFinite)) return;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = e.isBOS ? 2 : 1;
    ctx.setLineDash(e.isBOS ? [6, 4] : []);   // MC: BOS dashed, CHoCH solid
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
    ctx.setLineDash([]);

    if (ext.show_label) {
      ctx.font = 'bold italic 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = color;
      ctx.fillText((e.isSpan ? 's' : '') + String(e.span), (x1 + x2) / 2, y - 2);
    }
    ctx.restore();
  }

  // ===========================================================================
  // KLineChart template + registration plumbing (mirrors span_structure.js)
  // ===========================================================================
  const _byPane = new Map();
  const _paneKey = (paneId) => paneId || 'candle_pane';

  function _paramsToCalc(p) {
    return [
      p.left_strength, p.right_strength, p.min_swing_amount, p.swing_unit,
      p.span_ratio_lo, p.span_ratio_hi, p.min_break_gap, p.pivot_source, p.add_span,
      p.show_zones,
    ];
  }
  function _paramsToExtend(p) { return { ...DEFAULT_PARAMS, ...p }; }

  function _buildKlineTemplate() {
    return {
      name: 'BreakMarker',
      shortName: 'Break Marker',
      calcParams: _paramsToCalc(DEFAULT_PARAMS),
      extendData: _paramsToExtend(DEFAULT_PARAMS),
      styles: { tooltip: { showRule: 'none' } },
      calc(dataList, indicator) {
        const cp  = (indicator && indicator.calcParams) || [];
        const ext = (indicator && indicator.extendData) || {};
        const params = {
          left_strength:    cp[0] ?? ext.left_strength    ?? DEFAULT_PARAMS.left_strength,
          right_strength:   cp[1] ?? ext.right_strength   ?? DEFAULT_PARAMS.right_strength,
          min_swing_amount: cp[2] ?? ext.min_swing_amount ?? DEFAULT_PARAMS.min_swing_amount,
          swing_unit:       cp[3] || ext.swing_unit       || DEFAULT_PARAMS.swing_unit,
          span_ratio_lo:    cp[4] ?? ext.span_ratio_lo    ?? DEFAULT_PARAMS.span_ratio_lo,
          span_ratio_hi:    cp[5] ?? ext.span_ratio_hi    ?? DEFAULT_PARAMS.span_ratio_hi,
          min_break_gap:    cp[6] ?? ext.min_break_gap    ?? DEFAULT_PARAMS.min_break_gap,
          pivot_source:     cp[7] || ext.pivot_source     || DEFAULT_PARAMS.pivot_source,
          add_span:         cp[8] !== undefined ? cp[8] : (ext.add_span === true),
          show_zones:       cp[9] !== undefined ? cp[9] : (ext.show_zones === true),
        };
        const pivots = _buildPivots(dataList, params);
        const res = detect(dataList, pivots, params);
        // Skip the shared cache write for pane_manager.js's mirrored
        // multi-timeframe panes — see bos_choch.js's calc() for why.
        if (!ext.__pane_instance) {
          _byPane.set(_paneKey(indicator && indicator.paneId), res);
        }

        // Optional: frame supply/demand zones from THIS structure, reusing the
        // Supply/Demand indicator's pipeline (no duplication). Sealed structure
        // is dropped (drawing zones on dead structure = noise).
        let zones = null;
        if (params.show_zones) {
          const SD = (typeof window !== 'undefined') && window.SupplyDemandZones;
          if (SD && typeof SD.detectZones === 'function') {
            const ev = toZoneEvents(res, pivots, dataList).filter(e => !e.bmSealed);
            zones = SD.detectZones(ev, pivots, dataList, { ...(SD.defaultParams || {}) });
          }
        }

        const out = new Array(dataList.length).fill(null);
        if (out.length > 0) out[0] = { hi: res.hi, lo: res.lo, zones };
        return out;
      },
      draw({ ctx, kLineDataList, indicator, visibleRange, xAxis, yAxis }) {
        const ext = (indicator && indicator.extendData) || {};
        if (ext.hidden === true) return false;
        const result = indicator && indicator.result;
        if (!Array.isArray(result) || !result.length) return false;
        const data = result[0] || {};

        // Supply/demand zones first (behind the structure lines), via the S/D
        // indicator's own renderer so they look identical to that indicator.
        if (ext.show_zones && Array.isArray(data.zones) && data.zones.length) {
          const SD = (typeof window !== 'undefined') && window.SupplyDemandZones;
          if (SD && typeof SD.drawZones === 'function') {
            SD.drawZones(ctx, data.zones, { ...(SD.defaultParams || {}) }, xAxis, yAxis, kLineDataList, visibleRange);
          }
        }

        const hi = data.hi || [], lo = data.lo || [];
        if (!hi.length && !lo.length) return false;

        const from = visibleRange && visibleRange.realFrom != null ? visibleRange.realFrom : (visibleRange ? visibleRange.from : 0);
        const to   = visibleRange && visibleRange.realTo   != null ? visibleRange.realTo   : (visibleRange ? visibleRange.to   : kLineDataList.length - 1);
        const cull = (e) => !(e.bar > to + 2 || (e.bar + e.span) < from - 2);

        if (ext.show_hi !== false) for (const e of hi) { if (cull(e)) _drawEntry(ctx, e, ext, xAxis, yAxis); }
        if (ext.show_lo !== false) for (const e of lo) { if (cull(e)) _drawEntry(ctx, e, ext, xAxis, yAxis); }
        return false;
      },
    };
  }

  function add(chart, params) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    return chart.createIndicator({ name: 'BreakMarker', calcParams: _paramsToCalc(p), extendData: _paramsToExtend(p) }, true, { id: 'candle_pane' });
  }
  function remove(chart, paneId) {
    try { chart.removeIndicator({ name: 'BreakMarker' }, paneId || 'candle_pane'); } catch (e) { /* ignore */ }
    _byPane.delete(_paneKey(paneId));
  }
  function applyParams(chart, paneId, params, visible) {
    const p = { ...DEFAULT_PARAMS, ...(params || {}) };
    const ext = _paramsToExtend(p);
    if (visible === false) ext.hidden = true;
    try { chart.overrideIndicator({ name: 'BreakMarker', calcParams: _paramsToCalc(p), extendData: ext }, paneId || 'candle_pane'); } catch (e) { /* ignore */ }
  }
  function getResultForChart(_chart, paneId) { return _byPane.get(_paneKey(paneId)) || { hi: [], lo: [] }; }

  // ---- public API ----
  window.BreakMarker = {
    type: TYPE_NAME,
    name: 'Break Marker（Wister Span · 級別）',
    defaultParams: { ...DEFAULT_PARAMS },
    paramSchema: PARAM_SCHEMA,
    klineTemplate: _buildKlineTemplate(),
    add, remove, applyParams,
    ST_EMPTY, ST_ALIVE, ST_CHOCH, ST_CLOSED,
    detect,
    swingPivots,
    toZoneEvents,
    levelOf: _level,
    getResultForChart,
  };
})();
