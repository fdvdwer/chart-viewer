/* ============================================================================
 * cross_degree.js — Phase 4b: multi-degree fan-out + nesting + AI snapshot
 * ============================================================================
 * Spec: docs/specs/cross-degree-nesting-spec.md
 *
 * Pure, headless-first. Runs the EXISTING single-degree pipeline
 * (NWaveIndicator → BOSChoChDetector → SupplyDemandZones) on bars at several
 * timeframes, then joins them with a mechanical containment graph. The result
 * is an `asof`, no-lookahead, structure-only snapshot — the Phase 6 AI payload.
 *
 * Degrees come from AGGREGATION (1min source → resampled 5/15/30min), NOT from
 * recursion or strength-scaling (see spec §1.2). This module does NOT resample;
 * the caller passes already-aggregated bars per TF via `barsByTf`. (Browser:
 * fetch /api/ohlcv?tf=...; tests: synthetic bars.)
 *
 * Per VISION §2.2 (deterministic engine, AI only narrates): this layer states
 * what is mechanically true at `asof`. It does NOT decide which degree is
 * operative, whether a break is a trap, or whether to enter — that is Phase 6.
 *
 * Exports (window.CrossDegree):
 *   buildSnapshot(barsByTf, asof, params) -> snapshot   (pure)
 *   computeNesting(degrees, params) -> { relations, reversalZones }   (pure)
 *   getAiSnapshot(asof, opts) -> Promise<snapshot>       (browser: fetches bars)
 * ========================================================================== */

(function () {
  const TF_MINUTES = { '1': 1, '5': 5, '15': 15, '30': 30, '60': 60, '1h': 60, '4h': 240 };
  function _tfRank(tf) { return TF_MINUTES[tf] != null ? TF_MINUTES[tf] : (parseFloat(tf) || 0); }

  const DEFAULTS = {
    degrees: ['1', '5', '15', '30'],   // Q1
    // Detection — shared across degrees (Q2); override per-TF via degreeParams.
    left_strength: 1,
    right_strength: 1,
    min_swing_amount: 80,
    swing_unit: 'absolute',
    require_close_break: false,
    enforce_choch_below_bos: true,
    // Zone framing (mirror SupplyDemandZones defaults)
    zone_anchor: 'origin_to_force',
    zone_bounds: 'wick',
    force_lookback_bars: 10,
    emit_bos_zones: true,
    emit_choch_zones: true,
    test_threshold_pct: 50,
    sweep_threshold_pct: 100,
    auto_expire_untested: true,
    max_untested_age_bars: 100,
    auto_expire_tested: false,
    max_tested_age_bars: 300,
    // Nesting
    align_tol_ticks: 1,        // Q3
    align_tol_pct: 0.05,       // Q3 (whichever is larger wins)
    tick_size: 1,
    reversal_choch_run: 3,     // §2.3.1 / §721 "三個 CHoCH"
    // Per-TF override map, e.g. { '15': { min_swing_amount: 150 } }
    degreeParams: {},
  };

  function _mergeParams(p, tf) {
    const over = (p.degreeParams && p.degreeParams[tf]) || {};
    return Object.assign({}, p, over);
  }

  // --------------------------------------------------------------------------
  // Per-degree fan-out
  // --------------------------------------------------------------------------

  /**
   * Run the single-degree pipeline on `bars` (one TF) truncated to `asof`.
   * Returns a serialised degree: { id, tf, trend, pivots, events, zones }.
   * Timestamps (not bar indices) are used on all cross-degree-visible fields.
   */
  function _runDegree(degreeId, tf, bars, asof, p) {
    const N = (typeof window !== 'undefined') && window.NWaveIndicator;
    const D = (typeof window !== 'undefined') && window.BOSChoChDetector;
    const Z = (typeof window !== 'undefined') && window.SupplyDemandZones;
    const empty = { id: degreeId, tf, trend: 'unknown', pivots: [], events: [], zones: [] };
    if (!N || !D || !Z) { console.warn('[CrossDegree] detector modules missing'); return empty; }

    const mp = _mergeParams(p, tf);
    // NO LOOKAHEAD: only bars up to (and including) the bar at `asof`.
    const dl = Number.isFinite(asof) ? bars.filter(b => b.timestamp <= asof) : bars.slice();
    if (dl.length < 2) return empty;

    let seq, events;
    if (mp.structure_source === 'break_marker') {
      // Match the user's REAL visible chart (break_marker indicator, show_zones):
      // RAW swing pivots → BreakMarker.detect → toZoneEvents (drop sealed). See
      // supply_demand_zones.js structure_source:'break_marker' path.
      const BM = (typeof window !== 'undefined') && window.BreakMarker;
      if (!BM || typeof BM.detect !== 'function') { console.warn('[CrossDegree] BreakMarker dependency missing'); return empty; }
      seq = BM.swingPivots(dl, { add_span: mp.bm_add_span === true });
      const res = BM.detect(dl, seq, {
        span_ratio_lo: mp.span_ratio_lo != null ? mp.span_ratio_lo : 0.5,
        span_ratio_hi: mp.span_ratio_hi != null ? mp.span_ratio_hi : 2.0,
        min_break_gap: mp.min_break_gap != null ? mp.min_break_gap : 2,
      });
      events = BM.toZoneEvents(res, seq, dl);
      if (mp.skip_sealed !== false) events = events.filter(e => !e.bmSealed);
    } else {
      seq = N.detectAlternatingSequence(dl, mp.left_strength, mp.right_strength);
      seq = N.applyAmplitudeFilter(seq, Number(mp.min_swing_amount) || 0, mp.swing_unit);

      const evParams = {
        left_strength: mp.left_strength,
        right_strength: mp.right_strength,
        min_swing_amount: mp.min_swing_amount,
        swing_unit: mp.swing_unit,
        require_close_break: mp.require_close_break,
        enforce_choch_below_bos: mp.enforce_choch_below_bos,
      };
      events = D.detectEventsFromSeq(seq, dl, evParams);
    }
    const zones = Z.detectZones(events, seq, dl, mp);

    const tsAt = (idx) => (dl[idx] ? dl[idx].timestamp : null);

    // Trend at asof = the direction of the last event (BOS keeps trend, CHoCh
    // flips it — either way the last event's direction == current trend).
    const trend = events.length ? events[events.length - 1].direction : 'unknown';

    return {
      id: degreeId,
      tf,
      trend,
      pivots: seq.map(pv => ({ ts: tsAt(pv.barIdx), type: pv.type, price: pv.price })),
      events: events.map(e => ({
        id: `${e.type}_${e.direction}_${e.eventBarIdx}`,
        type: e.type,
        direction: e.direction,
        level: e.level,
        eventTs: e.eventTs,
        pivotTs: e.pivotTs,
        obTs: tsAt(e.obPivotBarIdx),
        obPrice: e.obPivotPrice,
      })),
      zones: zones.map(z => ({
        id: z.id,
        side: z.side,
        upper: z.bounds.upper,
        lower: z.bounds.lower,
        extreme: z.bounds.extreme,
        xFromTs: tsAt(z.bounds.xLeft),
        xToTs: tsAt(z.activeRightEdge != null ? z.activeRightEdge : z.bounds.xRight),
        status: z.status,
        eventTs: z.triggeredBy.eventTs,
        triggeredBy: `${z.triggeredBy.type}_${z.triggeredBy.direction}_${z.triggeredBy.eventBarIdx}`,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Nesting join (pure)
  // --------------------------------------------------------------------------

  function _alignTol(price, p) {
    const byTick = (Number(p.align_tol_ticks) || 0) * (Number(p.tick_size) || 1);
    const byPct = Math.abs(price) * (Number(p.align_tol_pct) || 0) / 100;
    return Math.max(byTick, byPct);
  }

  function _zoneContainsTs(zone, ts) {
    if (zone.xFromTs == null || zone.xToTs == null || ts == null) return false;
    return ts >= zone.xFromTs && ts <= zone.xToTs;
  }

  /**
   * Join degrees (small → large only, Q4). Emits { relations, reversalZones }.
   * `degrees` = array of _runDegree outputs.
   */
  function computeNesting(degrees, params) {
    const p = Object.assign({}, DEFAULTS, params || {});
    const ordered = degrees.slice().sort((a, b) => _tfRank(a.tf) - _tfRank(b.tf));
    const relations = [];
    const reversalZones = [];

    for (let ci = 0; ci < ordered.length; ci++) {
      const child = ordered[ci];
      for (let pi = ci + 1; pi < ordered.length; pi++) {
        const parent = ordered[pi];   // strictly larger TF (Q4: child < parent)

        // (1) event-vs-zone relations
        for (const ev of child.events) {
          for (const pz of parent.zones) {
            const inBand = ev.level >= pz.lower && ev.level <= pz.upper;
            const inX = _zoneContainsTs(pz, ev.eventTs);
            if (inBand && inX) {
              relations.push(_rel(child, parent, ev, pz, 'inside_zone'));
            }
            // aligned: child level ~ a parent zone edge
            const tol = _alignTol(ev.level, p);
            if (Math.abs(ev.level - pz.upper) <= tol || Math.abs(ev.level - pz.lower) <= tol) {
              relations.push(_rel(child, parent, ev, pz, 'aligned'));
            }
            // above/below an UNTESTED parent zone, reacting AFTER it formed
            if (pz.status === 'untested' && ev.eventTs > pz.eventTs) {
              if (ev.level > pz.upper) relations.push(_rel(child, parent, ev, pz, 'above_untested'));
              else if (ev.level < pz.lower) relations.push(_rel(child, parent, ev, pz, 'below_untested'));
            }
          }
        }

        // (2) reversal/force-zone flag (§2.3.1): K consecutive same-direction
        //     child CHoCh breaks, all above (or all below) the SAME untested
        //     parent zone, in time order.
        reversalZones.push(..._reversalZones(child, parent, p));
      }
    }
    return { relations, reversalZones };
  }

  function _rel(child, parent, ev, pz, relation) {
    return {
      child: { degree: child.id, tf: child.tf, kind: 'event', id: ev.id, level: ev.level, ts: ev.eventTs },
      parent: { degree: parent.id, tf: parent.tf, kind: 'zone', id: pz.id, side: pz.side, status: pz.status },
      relation,
    };
  }

  function _reversalZones(child, parent, p) {
    const out = [];
    const K = Math.max(1, Number(p.reversal_choch_run) || 3);
    const chochs = child.events
      .filter(e => e.type === 'CHoCh')
      .sort((a, b) => a.eventTs - b.eventTs);

    for (const pz of parent.zones) {
      if (pz.status !== 'untested') continue;
      // CHoCh that reacted after the parent zone formed, on one side of it.
      const side = (lvl) => (lvl > pz.upper ? 'above' : (lvl < pz.lower ? 'below' : null));
      let run = [];
      let runSide = null;
      let runDir = null;
      const flush = () => {
        if (run.length >= K) {
          out.push({
            parent: { degree: parent.id, tf: parent.tf, id: pz.id, side: pz.side, status: pz.status },
            childDegree: child.id, childTf: child.tf,
            side: runSide,
            direction: runDir,
            chochRun: run.map(e => e.id),
            nearestZoneId: _nearestZone(child, run[run.length - 1], runSide),
          });
        }
        run = []; runSide = null; runDir = null;
      };
      for (const e of chochs) {
        if (e.eventTs <= pz.eventTs) { continue; }
        const s = side(e.level);
        if (s && s === (runSide || s) && (runDir == null || runDir === e.direction)) {
          if (runSide == null) { runSide = s; runDir = e.direction; }
          run.push(e);
        } else {
          flush();
          if (s) { runSide = s; runDir = e.direction; run = [e]; }
        }
      }
      flush();
    }
    return out;
  }

  // Nearest small-degree S/D zone to the last CHoCh, on the run's side.
  function _nearestZone(child, lastEv, side) {
    let best = null, bestD = Infinity;
    for (const z of child.zones) {
      const ref = side === 'above' ? z.lower : z.upper;
      const d = Math.abs(ref - lastEv.level);
      if (d < bestD) { bestD = d; best = z.id; }
    }
    return best;
  }

  // --------------------------------------------------------------------------
  // Snapshot
  // --------------------------------------------------------------------------

  /**
   * @param barsByTf  { "1": bars[], "5": bars[], ... } already-aggregated
   * @param asof      cursor ms (no-lookahead vs this). null => use all bars.
   * @param params    overrides over DEFAULTS
   */
  function buildSnapshot(barsByTf, asof, params) {
    const p = Object.assign({}, DEFAULTS, params || {});
    const degreeList = (p.degrees || DEFAULTS.degrees);
    const degrees = degreeList.map((tf, i) => {
      const bars = (barsByTf && barsByTf[tf]) || [];
      return _runDegree('d' + i, tf, bars, asof, p);
    });
    const { relations, reversalZones } = computeNesting(degrees, p);
    return {
      schemaVersion: 1,
      asof: Number.isFinite(asof) ? asof : null,
      degrees,
      nesting: relations,
      reversalZones,
    };
  }

  // Browser convenience: fetch each TF then buildSnapshot. (Not used in tests.)
  async function getAiSnapshot(asof, opts) {
    const o = opts || {};
    const p = Object.assign({}, DEFAULTS, o.params || {});
    const symbol = o.symbol || (window.App && window.App.currentSymbol) || '';
    const barsByTf = {};
    await Promise.all((p.degrees || DEFAULTS.degrees).map(async (tf) => {
      const q = new URLSearchParams({ symbol, tf, before: String((asof || 0) + 1), limit: String(o.limit || 4000) });
      try {
        const r = await fetch('/api/ohlcv?' + q.toString(), { cache: 'no-store' });
        barsByTf[tf] = await r.json();
      } catch (e) { barsByTf[tf] = []; }
    }));
    return buildSnapshot(barsByTf, asof, p);
  }

  const api = { DEFAULTS, buildSnapshot, computeNesting, getAiSnapshot, _runDegree, _tfRank };
  if (typeof window !== 'undefined') window.CrossDegree = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
