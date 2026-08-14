/* ============================================================================
 * cross_degree_overlay.js — draw LARGER-degree structure on the current chart
 * ============================================================================
 * Companion to cross_degree_panel.js. Renders, on top of the current-TF chart,
 * the supply/demand zones + BOS/CHoCh structural lines of every degree LARGER
 * than the current TF (e.g. on a 5m chart: the 15m + 30m structure), positioned
 * by timestamp. The current TF's own structure (drawn by the existing
 * SupplyDemandZones / BOSChoChDetector indicators) then visually "sits inside"
 * the bigger-degree boxes — so cross-degree nesting is readable at a glance.
 *
 * A KLineChart custom indicator on the candle pane (same mechanism as
 * SupplyDemandZones). The snapshot is pushed in via extendData; draw() maps
 * each item's ts → current-chart pixel via findDataIndexByTimestamp + xAxis.
 * ========================================================================== */

(function () {
  const NAME = 'CrossDegreeOverlay';
  const TF_MIN = { '1': 1, '5': 5, '15': 15, '30': 30, '60': 60, '1h': 60, '4h': 240, '1d': 1440 };
  function _rank(tf) { return TF_MIN[tf] != null ? TF_MIN[tf] : (parseFloat(tf) || 0); }
  let _registered = false;

  function _withAlpha(hex, a) {
    if (!hex) return `rgba(120,123,134,${a})`;
    if (hex[0] === '#' && hex.length === 7) {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${a})`;
    }
    return hex;
  }

  function _xOf(xAxis, kLineDataList, ts) {
    if (ts == null) return null;
    let idx;
    if (typeof findDataIndexByTimestamp === 'function') idx = findDataIndexByTimestamp(kLineDataList, ts);
    else {
      // fallback binary search
      let lo = 0, hi = kLineDataList.length - 1; idx = hi;
      while (lo <= hi) { const m = (lo + hi) >> 1; const t = kLineDataList[m].timestamp; if (t === ts) { idx = m; break; } if (t < ts) { idx = m; lo = m + 1; } else hi = m - 1; }
    }
    const px = xAxis.convertToPixel(idx);
    return Number.isFinite(px) ? px : null;
  }

  const DEMAND = '#26a69a', SUPPLY = '#ef5350';

  const template = {
    name: NAME,
    shortName: 'X-Degree',
    calcParams: [],
    extendData: {},
    styles: { tooltip: { showRule: 'none' } },
    calc: (dataList) => new Array(dataList.length).fill(null),
    draw: ({ ctx, kLineDataList, indicator, xAxis, yAxis }) => {
      const ext = (indicator && indicator.extendData) || {};
      const snap = ext.snapshot;
      const curTf = ext.currentTf;
      if (!snap || !Array.isArray(snap.degrees) || !kLineDataList.length) return false;
      const curRank = _rank(curTf);
      const larger = snap.degrees.filter(d => _rank(d.tf) > curRank);
      if (!larger.length) return false;

      const W = ctx.canvas ? ctx.canvas.width : 100000;
      const cull = (xL, xR) => (xR != null && xR < -4) || (xL != null && xL > W + 4);

      ctx.save();
      // Larger degrees drawn from biggest → smallest so smaller sits on top.
      const ordered = larger.slice().sort((a, b) => _rank(b.tf) - _rank(a.tf));
      // Cap per degree — only the most RECENT items near the cursor. Drawing
      // every event/zone over the whole window is both unreadable (line
      // spaghetti) and slow (re-rendered on every pan/zoom). PROGRESS §4zl
      // "recency-limited nesting".
      const MAX_ZONES = 8, MAX_EVENTS = 5;
      for (const d of ordered) {
        const isBig = _rank(d.tf) >= 30;
        const lw = isBig ? 1.6 : 1.2;

        // ---- zones (only live ones, most recent few) ----
        const liveZones = d.zones.filter(z => z.status !== 'invalidated' && z.status !== 'expired').slice(-MAX_ZONES);
        for (const z of liveZones) {
          const xL = _xOf(xAxis, kLineDataList, z.xFromTs);
          let xR = _xOf(xAxis, kLineDataList, z.xToTs);
          if (xL == null) continue;
          if (xR == null || xR <= xL) xR = W;          // active zone → extend right
          if (cull(xL, xR)) continue;
          const yT = yAxis.convertToPixel(z.upper);
          const yB = yAxis.convertToPixel(z.lower);
          if (![yT, yB].every(Number.isFinite)) continue;
          const col = z.side === 'supply' ? SUPPLY : DEMAND;
          ctx.fillStyle = _withAlpha(col, 0.06);
          ctx.fillRect(xL, Math.min(yT, yB), Math.max(1, xR - xL), Math.abs(yB - yT));
          ctx.strokeStyle = _withAlpha(col, 0.65);
          ctx.lineWidth = lw;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(xL, Math.min(yT, yB), Math.max(1, xR - xL), Math.abs(yB - yT));
          ctx.setLineDash([]);
          // degree-tagged label at the structure-facing edge
          ctx.font = `bold ${isBig ? 11 : 10}px sans-serif`;
          ctx.fillStyle = _withAlpha(col, 0.95);
          ctx.textAlign = 'left';
          ctx.textBaseline = z.side === 'supply' ? 'bottom' : 'top';
          const ly = z.side === 'supply' ? Math.min(yT, yB) - 2 : Math.max(yT, yB) + 2;
          ctx.fillText(`${d.tf}m ${z.side === 'supply' ? 'SUPPLY' : 'DEMAND'}`, xL + 4, ly);
        }

        // ---- BOS / CHoCh structural lines (most recent few) ----
        for (const e of d.events.slice(-MAX_EVENTS)) {
          const y = yAxis.convertToPixel(e.level);
          const xP = _xOf(xAxis, kLineDataList, e.pivotTs);
          const xE = _xOf(xAxis, kLineDataList, e.eventTs);
          if (!Number.isFinite(y) || xP == null || xE == null) continue;
          const segL = Math.min(xP, xE), segR = Math.max(xP, xE);
          if (cull(segL, segR)) continue;
          const isCHoCh = e.type === 'CHoCh';
          const col = e.direction === 'up' ? DEMAND : SUPPLY;
          ctx.strokeStyle = _withAlpha(col, 0.7);
          ctx.lineWidth = lw;
          ctx.setLineDash(isCHoCh ? [5, 4] : []);
          ctx.beginPath(); ctx.moveTo(segL, y); ctx.lineTo(segR, y); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = _withAlpha(col, 0.85);
          ctx.beginPath(); ctx.arc(xE, y, 2.2, 0, Math.PI * 2); ctx.fill();
          ctx.font = `bold italic ${isBig ? 11 : 10}px sans-serif`;
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(`${d.tf}m ${isCHoCh ? 'CHOCH' : 'BOS'}${e.direction === 'up' ? '↑' : '↓'}`, xE + 5, y);
        }
      }
      ctx.restore();
      return false;
    },
  };

  function register() {
    if (_registered) return;
    try { klinecharts.registerIndicator(template); _registered = true; }
    catch (e) { console.warn('[CrossDegreeOverlay] register failed', e); }
  }

  let _shown = false;

  // Cheap to call every cursor tick during replay: create the indicator once,
  // then only push fresh extendData (→ redraw) on subsequent calls.
  function show(chart, snapshot, currentTf) {
    if (!chart) return;
    register();
    if (!_shown) {
      try { chart.createIndicator({ name: NAME, extendData: { snapshot, currentTf } }, true, { id: 'candle_pane' }); _shown = true; } catch (e) {}
    }
    try { chart.overrideIndicator({ name: NAME, extendData: { snapshot, currentTf } }, 'candle_pane'); } catch (e) {}
  }

  function hide(chart) {
    if (!chart) return;
    try { chart.removeIndicator({ name: NAME }, 'candle_pane'); } catch (e) {}
    _shown = false;
  }

  window.CrossDegreeOverlay = { register, show, hide };
})();
