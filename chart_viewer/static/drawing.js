/**
 * drawing.js — Drawing tools (trendline / rectangle / path) + snap + settings
 *
 * Hotkeys:
 *   Alt+T  trendline
 *   Alt+R  rectangle
 *   Alt+C  curve
 *   Alt+P  path
 *   Alt+M  measure (date & price range)
 *   Alt+L  long position (single click → default 1:1 R:R)
 *   Alt+S  short position (single click → default 1:1 R:R)
 *   Esc    cancel current drawing
 *   Del    remove selected drawing
 *
 * Snap modifiers (held during drawing):
 *   Ctrl   snap y-value to nearest OHLC of hovered bar
 *   Shift  lock to horizontal/vertical (relative to first point)
 *
 * Note: To remap snap keys, edit isOhlcSnapKey / isAxisLockKey below.
 */
/* global klinecharts */

const Drawing = {
  chart: null,
  activeTool: 'cross',           // 'cross' | 'trendline' | 'rectangle' | 'path'
  selectedOverlay: null,         // last clicked overlay
  // In-progress drawing state — getOverlays() doesn't return drawing overlays,
  // so we capture id + points via onDrawStart / onDrawing callbacks instead.
  drawingId: null,
  drawingPoints: [],
  // Clipboard + cursor tracking for copy/paste
  clipboard: null,               // {name, points, styles}
  lastCrosshair: null,           // {dataIndex, value, timestamp}
  lastMousePage: { pageX: 0, pageY: 0 },
  // Own registry — KLineChart's getOverlays() misses overlays for a while
  // after onDrawEnd, so we track id → overlay mirror ourselves.
  overlayRegistry: new Map(),
};

function trackOverlay(ov) {
  if (!ov || !ov.id) return;
  // Mini-drawn overlays live on the mini chart instance — keep them in a
  // SEPARATE registry so they don't pollute the main chart's registry /
  // persistence / branch filter. branchId = the mini's branch.
  if ((Drawing._drawHost || 'main') === 'mini') {
    const mbid = (window.BranchEngine && window.BranchEngine.miniBranchId) || 'main';
    if (!Drawing._miniRegistry) Drawing._miniRegistry = new Map();
    // Logical key (stable across reloads) + _ovid (the current mini-chart
    // overlay id; the one just drawn). Persist so it survives a reload.
    const key = 'm' + (Drawing._miniSeq = (Drawing._miniSeq || 0) + 1);
    Drawing._miniRegistry.set(key, {
      key, name: ov.name, visible: ov.visible !== false, lock: !!ov.lock,
      styles: ov.styles,
      points: (ov.points || []).map(p => ({ timestamp: p.timestamp, value: p.value })),
      extendData: ov.extendData, branchId: mbid, _ovid: ov.id,
    });
    schedulePersist();
    return;
  }
  // Every drawn overlay is BRANCH-SCOPED: it belongs to the
  // branch that was active when it was drawn, so switching the active
  // branch shows only that branch's overlays (see applyBranchFilter).
  // Indicator overlays don't go through trackOverlay → unaffected.
  // Overlays loaded from disk keep their saved branchId via
  // _hydrateOverlays; this path stamps freshly-drawn ones. A stored
  // branchId of null (pre-feature drawings) is treated as GLOBAL by
  // applyBranchFilter — always visible.
  const branchId = (window.BranchEngine && window.BranchEngine.activeBranchId) || 'main';
  Drawing.overlayRegistry.set(ov.id, {
    id: ov.id,
    name: ov.name,
    visible: ov.visible !== false,
    lock: !!ov.lock,
    styles: ov.styles,
    points: ov.points,
    extendData: ov.extendData,
    branchId,
  });
  // A brand-new overlay lands with zLevel 0 — BELOW every ranked overlay (which
  // start at 1) — so it would be buried under any rectangle covering it and
  // couldn't be clicked until a hover bumped it. Rank it immediately (coalesced,
  // so a bulk restore pays for one pass, not one per overlay).
  scheduleAutoZLevels();
  schedulePersist();
}
// Exposed so programmatic drawers can register their
// overlays as first-class: persisted with the layout, reanchored on TF/replay
// changes, and managed by clear-all / object tree — same lifecycle as
// user-drawn overlays.
Drawing.trackOverlay = trackOverlay;

// Branch-scoped overlay visibility. Position overlays carry a `branchId`
// (stamped in trackOverlay / restored in _hydrateOverlays). When the user
// switches the active branch we HIDE the position boxes that don't belong to
// it and show the ones that do — without touching `entry.visible`, which is
// the user's own manual eye-icon hide state (effective = both must be true).
// Global overlays (branchId null: structure lines, zones) are left alone.
function applyBranchFilter() {
  if (!Drawing.chart || !Drawing.overlayRegistry) return;
  const active = (window.BranchEngine && window.BranchEngine.activeBranchId) || 'main';
  for (const entry of Drawing.overlayRegistry.values()) {
    if (!entry || !entry.branchId) continue;        // global — untouched
    const eff = (entry.visible !== false) && (entry.branchId === active);
    try { Drawing.chart.overrideOverlay({ id: entry.id, visible: eff }); } catch (e) {}
  }
}
Drawing.applyBranchFilter = applyBranchFilter;

// Cascade-delete: when a branch is deleted (BranchEngine.deleteBranch emits
// 'branchDeleted'), every overlay that was drawn while that branch was active
// must be removed too — otherwise it orphans (keeps the dead branchId and, per
// applyBranchFilter, would never match any active branch again → invisible but
// still persisted). Children of the deleted branch re-parent (engine does that),
// but overlays DELETE, they don't re-parent. Covers BOTH the main
// overlayRegistry (via chart.removeOverlay) AND the mini _miniRegistry (via
// miniChart.removeOverlay when its _ovid is live).
function removeBranchOverlays(deletedId) {
  if (!deletedId) return;
  let removed = 0;
  // Main-chart overlays.
  if (Drawing.overlayRegistry) {
    const ids = [];
    for (const entry of Drawing.overlayRegistry.values()) {
      if (entry && entry.branchId === deletedId) ids.push(entry.id);
    }
    for (const id of ids) {
      try { if (Drawing.chart) Drawing.chart.removeOverlay({ id }); } catch (e) {}
      Drawing.overlayRegistry.delete(id);
      if (Drawing.selectedOverlay && Drawing.selectedOverlay.id === id) Drawing.selectedOverlay = null;
      removed++;
    }
  }
  // Mini-chart overlays.
  if (Drawing._miniRegistry) {
    const miniChart = window.MiniChart && window.MiniChart.chart;
    const keys = [];
    for (const [k, e] of Drawing._miniRegistry) {
      if (e && e.branchId === deletedId) keys.push([k, e]);
    }
    for (const [k, e] of keys) {
      if (e._ovid) { try { if (miniChart) miniChart.removeOverlay({ id: e._ovid }); } catch (err) {} }
      Drawing._miniRegistry.delete(k);
      if (Drawing.selectedOverlay && Drawing.selectedOverlay.id === e._ovid) Drawing.selectedOverlay = null;
      removed++;
    }
  }
  if (removed) {
    try { refreshObjectTree(); } catch (e) {}
    schedulePersist();
  }
  return removed;
}
Drawing.removeBranchOverlays = removeBranchOverlays;

// Render the mini-drawn overlays belonging to `branchId` onto the mini chart:
// override existing (reanchor dataIndex), create missing, drop the rest. Called
// by MiniChart on show / mini-branch switch — NOT per replay tick, so it never
// churns (unlike the reverted per-tick mirror). branchId null clears them all.
Drawing.renderMiniBranchOverlays = function (miniChart, branchId) {
  if (!miniChart || !Drawing._miniRegistry) return;
  const data = (miniChart.getDataList && miniChart.getDataList()) || [];
  const idxByTs = (ts) => { let b = 0; for (let i = 0; i < data.length; i++) { if (data[i].timestamp <= ts) b = i; else break; } return b; };
  for (const e of Drawing._miniRegistry.values()) {
    const want = !!branchId && e.branchId === branchId && e.visible !== false
      && e.points && e.points.length >= 2;
    if (!want) {
      if (e._ovid) { try { miniChart.removeOverlay({ id: e._ovid }); } catch (err) {} e._ovid = null; }
      continue;
    }
    const points = e.points.map(p => ({ timestamp: p.timestamp, value: p.value, dataIndex: idxByTs(p.timestamp) }));
    if (e._ovid) {
      try { miniChart.overrideOverlay({ id: e._ovid, points }); } catch (err) {}
    } else {
      const spec = { name: e.name, points };
      if (e.styles)     spec.styles     = e.styles;
      if (e.extendData) spec.extendData = e.extendData;
      try { const id = miniChart.createOverlay(spec); if (typeof id === 'string') e._ovid = id; } catch (err) {}
    }
  }
};

// Which chart instance an overlay id lives on: the main chart by default, the
// mini chart if the id matches a live _miniRegistry entry's _ovid. Lets
// operations on the selected overlay (live style preview, delete…) target the
// right chart instead of the hardcoded main one.
function _chartOf(id) {
  if (id && Drawing._miniRegistry) {
    for (const e of Drawing._miniRegistry.values()) {
      if (e._ovid === id) return (window.MiniChart && window.MiniChart.chart) || Drawing.chart;
    }
  }
  return Drawing.chart;
}
Drawing._chartOf = _chartOf;

function untrackOverlay(id) {
  if (id) {
    if (Drawing.overlayRegistry.has(id)) Drawing.overlayRegistry.delete(id);
    else if (Drawing._miniRegistry) {
      for (const [k, e] of Drawing._miniRegistry) { if (e._ovid === id) { Drawing._miniRegistry.delete(k); break; } }
    }
  }
  schedulePersist();
}

function updateTrackedOverlay(id, patch) {
  const entry = Drawing.overlayRegistry.get(id);
  if (entry) { Object.assign(entry, patch); schedulePersist(); return; }
  // Mini-drawn overlay — patch its _miniRegistry entry (id === live _ovid).
  if (Drawing._miniRegistry) {
    for (const e of Drawing._miniRegistry.values()) {
      if (e._ovid === id) { Object.assign(e, patch); schedulePersist(); return; }
    }
  }
  schedulePersist();
}

// ===== Overlay persistence (localStorage) =====
// Drawings survive a page refresh. Only manual deletion (Del key, context menu
// "remove", or object-tree trash icon) removes them. Saved: name, timestamps
// (canonical — dataIndex is recomputed on load), styles, extendData, lock,
// visible. Skipped: in-progress drawings.
// Drawings live on the backend under user_data/layouts/<layoutId>/drawings/
// <symbol>.json so they persist across browsers/machines AND are isolated per
// layout. localStorage is used as a fallback cache only.
function storageKey(symbol, layoutId) {
  const sym = symbol || (window.App && window.App.currentSymbol) || 'default';
  const lid = layoutId || (window.App && window.App.currentLayoutId) || 'default';
  return `chart_viewer_overlays_v2_${lid}_${sym}`;
}

// Build the array of serializable overlay entries from the in-memory registry.
function _snapshotOverlays() {
  const items = [];
  for (const e of Drawing.overlayRegistry.values()) {
    if (!e || !e.id) continue;
    if (e.id === Drawing.drawingId) continue;          // skip in-progress
    if (!e.points || e.points.length < 2) continue;
    const pts = e.points.map(p => ({
      timestamp: Number.isFinite(p.timestamp) ? p.timestamp : null,
      value: p.value,
    })).filter(p => Number.isFinite(p.timestamp) && Number.isFinite(p.value));
    if (pts.length < 2) continue;
    items.push({
      name: e.name,
      points: pts,
      styles: e.styles || null,
      extendData: e.extendData || null,
      lock: !!e.lock,
      visible: e.visible !== false,
      branchId: e.branchId || null,
      host: 'main',
    });
  }
  // Mini-drawn overlays (separate registry) — persisted alongside the main
  // ones with host:'mini' so restore routes them back to the mini chart.
  if (Drawing._miniRegistry) {
    for (const e of Drawing._miniRegistry.values()) {
      if (!e || !e.points || e.points.length < 2) continue;
      const pts = e.points.map(p => ({
        timestamp: Number.isFinite(p.timestamp) ? p.timestamp : null, value: p.value,
      })).filter(p => Number.isFinite(p.timestamp) && Number.isFinite(p.value));
      if (pts.length < 2) continue;
      items.push({
        name: e.name, points: pts, styles: e.styles || null,
        extendData: e.extendData || null, lock: !!e.lock,
        visible: e.visible !== false, branchId: e.branchId || null, host: 'mini',
      });
    }
  }
  return items;
}

let _persistTimer = null;
function schedulePersist() {
  // Debounce — many events fire in quick succession (drag, applyLive sliders).
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => { _persistTimer = null; persistOverlays(); }, 250);
}

async function persistOverlays(symbol, layoutId) {
  if (!Drawing.overlayRegistry) return;
  const items = _snapshotOverlays();
  const sym = symbol || (window.App && window.App.currentSymbol);
  const lid = layoutId || (window.App && window.App.currentLayoutId);
  try { localStorage.setItem(storageKey(sym, lid), JSON.stringify(items)); } catch (e) {}
  if (!sym || !lid) return;
  try {
    await fetch(`/api/drawings?layout=${encodeURIComponent(lid)}&symbol=${encodeURIComponent(sym)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(items),
    });
  } catch (e) { /* backend unreachable — no-op */ }
}

// Parse an items array and create the overlays. Shared by restoreOverlays
// (primary) and the localStorage-fallback path.
function _hydrateOverlays(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  const bars = (window.App && window.App.currentBars) || [];
  let count = 0;
  for (const item of items) {
    if (!item || !item.name || !Array.isArray(item.points) || item.points.length < 2) continue;
    // Mini-drawn overlays: stash in _miniRegistry (logical, no chart overlay
    // yet). Rendered on the mini chart when it opens on their branch.
    if (item.host === 'mini') {
      if (!Drawing._miniRegistry) Drawing._miniRegistry = new Map();
      const key = 'm' + (Drawing._miniSeq = (Drawing._miniSeq || 0) + 1);
      Drawing._miniRegistry.set(key, {
        key, name: item.name,
        points: item.points.map(p => ({ timestamp: p.timestamp, value: p.value })),
        styles: item.styles || undefined, extendData: item.extendData || undefined,
        lock: !!item.lock, visible: item.visible !== false,
        branchId: item.branchId || null, _ovid: null,
      });
      count++;
      continue;
    }
    const points = item.points.map(p => ({
      timestamp: p.timestamp,
      value: p.value,
      dataIndex: bars.length ? findDataIndexByTimestamp(bars, p.timestamp) : 0,
    }));
    const branchId = item.branchId || null;
    const active = (window.BranchEngine && window.BranchEngine.activeBranchId) || 'main';
    const branchVisible = !branchId || branchId === active;
    const opts = { name: item.name, points };
    if (item.styles)     opts.styles     = item.styles;
    if (item.extendData) opts.extendData = item.extendData;
    if (item.lock)       opts.lock       = true;
    // Effective visibility = user's manual visible AND branch match, so a
    // branch-scoped box hydrates hidden when it isn't the active branch's.
    if (item.visible === false || !branchVisible) opts.visible = false;
    let newId;
    try { newId = Drawing.chart.createOverlay(opts); } catch (err) { continue; }
    if (typeof newId !== 'string') continue;
    Drawing.overlayRegistry.set(newId, {
      id: newId, name: item.name, points,
      styles: item.styles || undefined,
      extendData: item.extendData || undefined,
      lock: !!item.lock, visible: item.visible !== false,
      branchId,
    });
    count++;
  }
  return count;
}

async function restoreOverlays(symbol, layoutId) {
  if (!Drawing.chart) return;
  const sym = symbol || (window.App && window.App.currentSymbol);
  const lid = layoutId || (window.App && window.App.currentLayoutId);
  if (!sym || !lid) { refreshObjectTree(); return; }
  let serverItems = null;
  try {
    const r = await fetch(`/api/drawings?layout=${encodeURIComponent(lid)}&symbol=${encodeURIComponent(sym)}`);
    if (r.ok) serverItems = await r.json();
  } catch (e) { /* backend unreachable */ }

  if (Array.isArray(serverItems) && serverItems.length) {
    _hydrateOverlays(serverItems);
    try { localStorage.setItem(storageKey(sym, lid), JSON.stringify(serverItems)); } catch (e) {}
    // Rank the restored drawings by area so a rectangle never sits above what
    // it covers (see the Z-ORDER block).
    try { applyAutoZLevels(); } catch (e) {}
    refreshObjectTree();
    applyBranchFilter();
    _rerenderMiniAfterRestore();
    return;
  }

  // Backend empty / unreachable → try localStorage cache.
  let cached;
  try { cached = JSON.parse(localStorage.getItem(storageKey(sym, lid)) || '[]'); }
  catch (e) { cached = []; }
  if (!Array.isArray(cached) || !cached.length) { refreshObjectTree(); return; }
  _hydrateOverlays(cached);
  // If server was reachable but empty, seed it from cache.
  if (Array.isArray(serverItems)) {
    try {
      await fetch(`/api/drawings?layout=${encodeURIComponent(lid)}&symbol=${encodeURIComponent(sym)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cached),
      });
    } catch (e) {}
  }
  // Same ranking pass for the localStorage-cache restore path.
  try { applyAutoZLevels(); } catch (e) {}
  refreshObjectTree();
  applyBranchFilter();
  _rerenderMiniAfterRestore();
}

// After drawings restore, if the mini chart is already open, re-render its
// branch overlays now that _miniRegistry is hydrated (MiniChart.init's first
// _show may have run before restore finished, so its overlays were skipped).
function _rerenderMiniAfterRestore() {
  if (window.MiniChart && window.MiniChart.chart && window.BranchEngine
      && Drawing.renderMiniBranchOverlays) {
    try { Drawing.renderMiniBranchOverlays(window.MiniChart.chart, window.BranchEngine.miniBranchId); }
    catch (e) { /* ignore */ }
  }
}

// One-time migration: if the old global key still exists and the current
// symbol has no drawings stored yet, move them over.
function _migrateLegacyOverlays() {
  const sym = (window.App && window.App.currentSymbol) || null;
  if (!sym) return;
  const newKey = storageKey(sym);
  const oldKey = 'chart_viewer_overlays_v1';
  try {
    if (localStorage.getItem(newKey) != null) return;   // already migrated
    const legacy = localStorage.getItem(oldKey);
    if (!legacy) return;
    localStorage.setItem(newKey, legacy);
    localStorage.removeItem(oldKey);
    console.log(`[Drawing] migrated legacy overlays → ${newKey}`);
  } catch (e) { /* ignore */ }
}

// Called from app.js when the user switches instruments within the SAME layout.
function handleSymbolChange(oldSymbol, newSymbol) {
  if (oldSymbol) persistOverlays(oldSymbol);   // flush under old key first
  if (Drawing.chart) {
    try { Drawing.chart.removeOverlay(); } catch (e) { /* ignore */ }
  }
  Drawing.overlayRegistry.clear();
  Drawing.selectedOverlay = null;
  Drawing.drawingId = null;
  Drawing.drawingPoints = [];
  restoreOverlays(newSymbol);
}
Drawing.onSymbolChanged = handleSymbolChange;

// Called from app.js after switching to a different LAYOUT. Clears the chart
// (drawings from the old layout live under a different key, so they stay on
// disk) and loads the new layout's drawings for the given symbol.
function handleLayoutChange(symbol) {
  if (Drawing.chart) {
    try { Drawing.chart.removeOverlay(); } catch (e) {}
  }
  Drawing.overlayRegistry.clear();
  Drawing.selectedOverlay = null;
  Drawing.drawingId = null;
  Drawing.drawingPoints = [];
  restoreOverlays(symbol);
}
Drawing.onLayoutChanged = handleLayoutChange;
window.Drawing = Drawing;

// ===== Snap state (shared with custom overlay templates) =====
window.SnapState = {
  ctrlHeld: false,
  shiftHeld: false,
};

// ===== Hotkey predicates (centralized so they're easy to remap) =====
const isOhlcSnapKey = (e) => e.ctrlKey || e.metaKey;
const isAxisLockKey = (e) => e.shiftKey;

// ===== Snap helper: nearest OHLC value of a bar =====
function snapToOHLC(bar, value) {
  if (!bar) return value;
  const cands = [bar.open, bar.high, bar.low, bar.close];
  let best = cands[0], bestDist = Math.abs(value - best);
  for (const c of cands) {
    const d = Math.abs(value - c);
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return best;
}

// ===== Shared cursor helper =====
// KLineChart paints its own cursor on the canvas children; setting cursor on
// `document.body` alone is insufficient because child inline styles win. Push
// the value to #chart AND each canvas child with `!important` (same technique
// as the rect hover cursor). Pass '' to clear.
function setGlobalCursor(value) {
  // Apply to BOTH the main and mini chart containers — the canvas' own cursor
  // overrides body, so setting only #chart left the mini with no grab/grabbing
  // feedback during a drag.
  const els = [document.getElementById('chart'), document.getElementById('mini-chart')];
  if (value) {
    document.body.style.cursor = value;
    for (const el of els) {
      if (!el) continue;
      el.style.setProperty('cursor', value, 'important');
      el.querySelectorAll('canvas').forEach(cv => cv.style.setProperty('cursor', value, 'important'));
    }
  } else {
    document.body.style.cursor = '';
    for (const el of els) {
      if (!el) continue;
      el.style.removeProperty('cursor');
      el.querySelectorAll('canvas').forEach(cv => cv.style.removeProperty('cursor'));
    }
  }
}

// Tracks whether an overlay drag is in progress (trendline/path endpoint drag
// via KLineChart's performEventPressedMove). Used by onMouseEnter/Leave below
// to not stomp the 'grabbing' cursor mid-drag when the figure hit-test flickers.
// Rectangle drag uses its own `_rectDrag` flag — both are checked.
let _overlayDrag = false;

// Which overlay is currently under the mouse (per KLineChart's hit-test).
// Used to conditionally render the trendline "+ 新增文字" placeholder only on
// hover of the selected line.
let _hoveredOverlayId = null;
// Separate wider-tolerance hit-test for trendline "+ 新增文字" placeholder.
// KLineChart's built-in line hit-test is only a few px so the placeholder
// flickers when the user's cursor is close-to-but-not-on the stroke.
let _trendlineHoverId = null;
const TRENDLINE_HOVER_TOL = 12;   // px

function _distToLineSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Is (mx, my) inside the trendline's text or "+ 新增文字" placeholder box?
// Used to narrow click-to-edit trigger so clicking OTHER parts of the line
// just selects (doesn't immediately open the editor).
function _clickOnTrendlineText(mx, my, entry) {
  if (!entry || !entry.points || entry.points.length < 2) return false;
  let out;
  try {
    out = Drawing.chart.convertToPixel(
      [entry.points[0], entry.points[1]], { paneId: 'candle_pane' });
  } catch (e) { return false; }
  if (!Array.isArray(out) || out.length < 2) return false;
  const pL = out[0].x <= out[1].x ? out[0] : out[1];
  const pR = out[0].x <= out[1].x ? out[1] : out[0];
  const dx = pR.x - pL.x, dy = pR.y - pL.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return false;
  const ux = dx / len, uy = dy / len;
  const angle = Math.atan2(dy, dx);

  const cur = (entry.extendData && entry.extendData.text) || null;
  const content = (cur && cur.content)
    || ((window.I18n && window.I18n.t) ? window.I18n.t('tool.addText') : '+ 新增文字');
  const t = { ...DEFAULT_TEXT_STATE, ...(cur || {}), content };

  const ctx = _textMeasureCtx();
  const italic = t.italic ? 'italic ' : '';
  const weight = t.bold ? 900 : 400;
  ctx.font = `${italic}${weight} ${t.size}px "Noto Sans SC", sans-serif`;
  const textWidth = ctx.measureText(content.replace(/\r?\n/g, ' ')).width;

  // Match anchor math used in buildTrendlineTextFigures.
  const edgePad = 8;
  let centerX, centerY;
  if (t.hAlign === 'left') {
    const dAlong = edgePad + textWidth / 2;
    centerX = pL.x + ux * dAlong;
    centerY = pL.y + uy * dAlong;
  } else if (t.hAlign === 'right') {
    const dAlong = edgePad + textWidth / 2;
    centerX = pR.x - ux * dAlong;
    centerY = pR.y - uy * dAlong;
  } else {
    centerX = (pL.x + pR.x) / 2;
    centerY = (pL.y + pR.y) / 2;
  }

  // Transform click into text-local frame (inverse rotation about centerX,Y).
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  const lx = (mx - centerX) * cos - (my - centerY) * sin;
  const ly = (mx - centerX) * sin + (my - centerY) * cos;

  const padX = 12, padY = 8;
  const halfW = textWidth / 2 + padX;
  const halfH = t.size * 0.6 + padY;
  return Math.abs(lx) <= halfW && Math.abs(ly) <= halfH;
}

// Build overlay points for the MINI chart: dataIndex computed against the
// mini's OWN bars (independent of the main chart's index).
function _pointsForMini(miniChart, pts) {
  const data = (miniChart && miniChart.getDataList && miniChart.getDataList()) || [];
  const idxByTs = (ts) => { let b = 0; for (let i = 0; i < data.length; i++) { if (data[i].timestamp <= ts) b = i; else break; } return b; };
  return (pts || []).map(p => ({ timestamp: p.timestamp, value: p.value, dataIndex: idxByTs(p.timestamp) }));
}

// Repaint an overlay on the chart it lives on. The main chart repaints itself
// on select/deselect; the mini chart doesn't, and an empty overrideOverlay is a
// no-op — so re-pass the overlay's own points to force createPointFigures to
// re-run (which is what paints/clears the selection handles).
function _repaintOverlayOnItsChart(id) {
  const c = _chartOf(id);
  if (!c || c === Drawing.chart) return;   // main repaints on its own
  try {
    const o = c.getOverlayById && c.getOverlayById(id);
    if (o && o.points) c.overrideOverlay({ id, points: o.points.map(p => ({ ...p })) });
  } catch (e) { /* ignore */ }
}

// ===== Shared interaction handlers for selectable overlays =====
// (path_snap = drawing template, NOT included; right-click on it finalizes path)
const overlayInteractions = {
  onSelected: (event) => {
    if (event && event.overlay) {
      Drawing.selectedOverlay = event.overlay;
      _repaintOverlayOnItsChart(event.overlay.id);
      markSelectedTreeRow(event.overlay.id);   // canvas click → highlight tree row
    }
    return true;
  },
  onDeselected: () => {
    const prev = Drawing.selectedOverlay;
    Drawing.selectedOverlay = null;
    if (prev && prev.id) _repaintOverlayOnItsChart(prev.id);
    markSelectedTreeRow(null);                  // clear tree-row highlight
    return true;
  },
  onRightClick: (event) => {
    if (event && event.overlay) {
      Drawing.selectedOverlay = event.overlay;
      markSelectedTreeRow(event.overlay.id);
    }
    showContextMenu(Drawing.lastMousePage.pageX, Drawing.lastMousePage.pageY);
    return true; // tell KLineChart we handled it
  },
  onMouseEnter: (event) => {
    if (event && event.overlay) {
      // CANCEL KLineChart's hover bump. Its store does, in this exact order:
      //   instance.setZLevel(Number.MAX_SAFE_INTEGER) → onMouseEnter (here) → _sort()
      // so writing our own level back NOW means the sort never sees the bump.
      // Restoring on mouseLeave instead does NOT work: once an overlay big enough
      // to cover the chart is bumped, it stays the hover target forever, the
      // hovered instance never changes, leave never fires — a deadlock where
      // nothing underneath can be hovered or clicked again.
      cancelHoverZBump(event.overlay);
      _hoveredOverlayId = event.overlay.id;
      setObjectTreeHover(event.overlay.id, true);
      // Trigger a redraw so trendline placeholder can appear on hover. Route to
      // the overlay's own chart so a mini trendline redraws on the mini.
      if (event.overlay.name === 'trendline_snap' && Drawing.chart) {
        try { _chartOf(event.overlay.id).overrideOverlay({ id: event.overlay.id }); } catch (e) {}
      }
      // Pointer cursor signals "this is clickable/draggable". Rectangle is
      // handled by its own mousemove hit-test (handle = resize arrow,
      // body = pointer), so skip it here.
      if (!_overlayDrag && !_rectDrag && event.overlay.name !== 'rectangle_snap') {
        setGlobalCursor('pointer');
      }
    }
    return false;
  },
  onMouseLeave: (event) => {
    if (event && event.overlay) {
      if (_hoveredOverlayId === event.overlay.id) _hoveredOverlayId = null;
      setObjectTreeHover(event.overlay.id, false);
      // KLineChart bumped this overlay to zLevel MAX_SAFE_INTEGER on enter and
      // never puts it back — without this, whatever you last hovered stays on
      // top forever and swallows clicks (see the Z-ORDER block).
      restoreZLevelAfterHover(event.overlay.id);
      if (event.overlay.name === 'trendline_snap' && Drawing.chart) {
        try { _chartOf(event.overlay.id).overrideOverlay({ id: event.overlay.id }); } catch (e) {}
      }
      if (!_overlayDrag && !_rectDrag && event.overlay.name !== 'rectangle_snap') {
        setGlobalCursor('');
      }
    }
    return false;
  },
  // Grabbing cursor while KLineChart is dragging a default-point handle
  // (fires for trendline endpoints and path vertices; rectangle uses its
  // own custom mousedown flow — see initRectHandleDrag).
  onPressedMoveStart: (event) => {
    _overlayDrag = true;
    setGlobalCursor('grabbing');
    // Snapshot points BEFORE the drag so Ctrl+Z can revert. We deep-
    // copy because KLineChart mutates the points array in place during
    // drag (we'd otherwise capture a live reference that ends at the
    // post-drag values).
    const ov = event && event.overlay;
    if (ov && ov.id && Array.isArray(ov.points)) {
      _overlayDragBefore = {
        id: ov.id,
        points: ov.points.map(p => ({ ...p })),
      };
    } else {
      _overlayDragBefore = null;
    }
    return false;
  },
  onPressedMoveEnd:   (event) => {
    _overlayDrag = false;
    setGlobalCursor('');
    // Sync the dragged overlay's new points back to the registry + persist.
    // chart-aware: a mini overlay's points go to _miniRegistry (timestamp+
    // value); the main registry never has its id, so the old code silently
    // dropped drag edits on mini overlays (undo/persist saw stale shape).
    const ov = event && event.overlay;
    if (ov && ov.id && Array.isArray(ov.points)) {
      const opChart = _chartOf(ov.id);
      const isMini = opChart !== Drawing.chart;
      const syncReg = (id, pts) => {
        if (isMini) {
          if (Drawing._miniRegistry) for (const e of Drawing._miniRegistry.values()) {
            if (e._ovid === id) { e.points = pts.map(p => ({ timestamp: p.timestamp, value: p.value })); break; }
          }
        } else {
          const entry = Drawing.overlayRegistry.get(id);
          if (entry) entry.points = pts.map(p => ({ ...p }));
        }
      };
      const ptsFor = (pts) => isMini ? _pointsForMini(opChart, pts) : _pointsForChart(pts);
      syncReg(ov.id, ov.points);
      // Push undo entry — drag was a single logical operation.
      const before = _overlayDragBefore;
      if (before && before.id === ov.id) {
        const after = ov.points.map(p => ({ ...p }));
        const sameAsBefore = before.points.length === after.length
          && before.points.every((p, i) =>
              p.timestamp === after[i].timestamp && p.value === after[i].value);
        if (!sameAsBefore) {
          const id = ov.id;
          const beforePts = before.points;
          pushUndo({
            label: 'Move overlay',
            undo: () => { try { opChart.overrideOverlay({ id, points: ptsFor(beforePts) }); } catch (e) {} syncReg(id, beforePts); },
            redo: () => { try { opChart.overrideOverlay({ id, points: ptsFor(after) }); } catch (e) {} syncReg(id, after); },
          });
        }
      }
    }
    _overlayDragBefore = null;
    schedulePersist();
    return false;
  },
};
// Captured by onPressedMoveStart, consumed by onPressedMoveEnd. Not in
// the overlayInteractions object because it's a module-private state
// used for undo bookkeeping, not a KLineChart hook.
let _overlayDragBefore = null;

// Highlight the Object Tree row that matches the hovered overlay.
function setObjectTreeHover(id, on) {
  const list = document.getElementById('obj-tree-list');
  if (!list || !id) return;
  const row = list.querySelector(`[data-overlay-id="${id}"]`);
  if (row) row.classList.toggle('hover', !!on);
}

// Mark the object-tree row for `id` as selected (clears any prior selection).
// Pass null/undefined to just clear. Kept in sync with Drawing.selectedOverlay
// from BOTH directions: a chart click (overlayInteractions.onSelected) and an
// object-tree row click (selectOverlayFromTree).
function markSelectedTreeRow(id) {
  const list = document.getElementById('obj-tree-list');
  if (!list) return;
  list.querySelectorAll('.obj-row.selected').forEach(r => r.classList.remove('selected'));
  if (id) {
    const row = list.querySelector(`[data-overlay-id="${id}"]`);
    if (row) row.classList.add('selected');
  }
}
Drawing.markSelectedTreeRow = markSelectedTreeRow;

// Force an overlay to re-run createPointFigures on whichever chart it lives on,
// so its selection handles paint/clear when Drawing.selectedOverlay changes from
// a NON-canvas source (an object-tree click). Unlike _repaintOverlayOnItsChart
// this also repaints the MAIN chart — a JS-set selection doesn't trigger
// KLineChart's own on-select redraw, so the handles wouldn't appear otherwise.
function _forceSelectRepaint(id) {
  const c = _chartOf(id);
  if (!c) return;
  try {
    const o = c.getOverlayById && c.getOverlayById(id);
    if (o && o.points) c.overrideOverlay({ id, points: o.points.map(p => ({ ...p })) });
  } catch (e) { /* ignore */ }
}

// Select an overlay from an object-tree row click: set the JS selection, repaint
// the old + new overlay so handles move, and highlight the row. Mirrors what a
// canvas click does (overlayInteractions.onSelected) so the two stay in sync.
function selectOverlayFromTree(id) {
  if (!id) return;
  const prev = Drawing.selectedOverlay;
  const c = _chartOf(id);
  const live = (c && c.getOverlayById && c.getOverlayById(id)) || null;
  Drawing.selectedOverlay = live || Drawing.overlayRegistry.get(id) || { id };
  if (prev && prev.id && prev.id !== id) _forceSelectRepaint(prev.id);
  _forceSelectRepaint(id);
  markSelectedTreeRow(id);
}
Drawing.selectOverlayFromTree = selectOverlayFromTree;

// Open the mini (sub) chart showing `branchId` (idempotent). The mini's
// visibility is driven by BranchEngine.miniBranchId → setMiniBranch shows it and
// renders that branch's mini overlays (which assigns each entry its live _ovid).
function _ensureMiniOpenForBranch(branchId) {
  const BE = window.BranchEngine;
  const MC = window.MiniChart;
  if (!BE || !BE.setMiniBranch) return;
  const bid = branchId || (BE.miniBranchId) || 'main';
  const needShow = BE.miniBranchId !== bid || (MC && MC.el && MC.el.hidden);
  if (needShow) { try { BE.setMiniBranch(bid); } catch (e) {} }
}

// Scroll `chart` so `ts` sits near the center of the viewport. scrollToDataIndex
// right-aligns its arg, so we add half a viewport to center the object.
function _jumpChartToTimestamp(chart, ts) {
  if (!chart || !Number.isFinite(ts) || !chart.scrollToDataIndex) return;
  const bars = (chart.getDataList && chart.getDataList()) || [];
  if (!bars.length) return;
  const idx = findDataIndexByTimestamp(bars, ts);
  const vr = chart.getVisibleRange ? chart.getVisibleRange() : null;
  const width = vr ? Math.max(10, vr.to - vr.from) : 60;
  // Instant (duration 0): a jump is a teleport, and an animated scroll depends
  // on requestAnimationFrame — reliable and verifiable without it.
  try { chart.scrollToDataIndex(Math.round(idx + width / 2), 0); } catch (e) {}
}

// Jump the chart(s) to an overlay's location. A mini overlay first opens the mini
// for its branch (so it's visible); the mini viewport is X-synced to the main, so
// scrolling the main brings the mini along — we also nudge the mini directly.
function jumpToOverlay(host, branchId, ts) {
  if (host === 'mini') _ensureMiniOpenForBranch(branchId);
  // In replay, delegate to the replay engine's jump — it loads a bounded history
  // window around ts (the date-picker path), so a jump to an object outside the
  // loaded window doesn't stretch the placeholder zone / compress the K-bars.
  // The mini viewport is X-synced, so it follows. In live mode a plain
  // scrollToDataIndex is enough (bars are already loaded / lazy-load on scroll).
  // In replay, jumping to an object in the ALREADY-PLAYED bars is VIEW-ONLY —
  // scroll to it WITHOUT moving the replay cursor, so it does NOT count as
  // replay progress (no rewind, no maxCursorTs bump [spec §3.2.3 anti-lookahead
  // boundary], no tick-record wipe). But an object the replay HASN'T reached yet
  // (ts past the cursor → placeholder bars, not loaded) or before the loaded
  // window can't be shown that way, so: EXIT replay + load a bounded window
  // around it (Aaron's ask — the replay's future bars simply aren't there).
  if (window.Replay && window.Replay.active) {
    const R = window.Replay;
    const bb = R.baseBars;
    const firstLoaded = (bb && bb.length) ? bb[0].timestamp : null;
    const showable = Number.isFinite(R.cursorTimestamp) && Number.isFinite(firstLoaded)
      && Number.isFinite(ts) && ts >= firstLoaded && ts <= R.cursorTimestamp;
    if (showable) { _scrollReplayViewToTs(ts); return; }
    _exitReplayAndBrowse(ts);
    return;
  }
  // Live mode: if the object's time is OUTSIDE the loaded window (e.g. a drawing
  // made during a replay of an old period), a plain scroll can't show it — the
  // bars aren't loaded, so it clamps to the window edge. Load a bounded window
  // around it instead (App.browseToTimestamp); the 回到最新 button returns to now.
  const bars = (window.App && window.App.currentBars) || [];
  const outside = bars.length && Number.isFinite(ts)
    && (ts < bars[0].timestamp || ts > bars[bars.length - 1].timestamp);
  if (outside && window.App && window.App.browseToTimestamp) {
    window.App.browseToTimestamp(ts);
    return;
  }
  _jumpChartToTimestamp(Drawing.chart, ts);
  _syncMiniToTs(ts);   // the mini shares the data but not the programmatic scroll
}
Drawing.jumpToOverlay = jumpToOverlay;

// Bring the open mini chart to `ts` too. The mini shares the main's data
// (Replay.displayBars / App.currentBars) but only mirrors the main via scroll
// DELTA events — a programmatic scrollToDataIndex does NOT fire those, so the
// mini wouldn't follow a jump (its K-line stays put / looks unloaded). Compute
// the mini's own index for ts and scroll it there; refreshData first in case its
// data went stale.
function _syncMiniToTs(ts) {
  const MC = window.MiniChart;
  if (!MC || !MC.chart || !MC.el || MC.el.hidden || !MC.chart.scrollToDataIndex || !Number.isFinite(ts)) return;
  try { if (MC.refreshData) MC.refreshData(); } catch (e) {}
  const bars = (MC.chart.getDataList && MC.chart.getDataList()) || [];
  if (!bars.length) return;
  const idx = findDataIndexByTimestamp(bars, ts);
  const vr = MC.chart.getVisibleRange ? MC.chart.getVisibleRange() : null;
  const width = vr ? Math.max(10, vr.to - vr.from) : 60;
  try { MC.chart.scrollToDataIndex(Math.round(idx + width / 2), 0); } catch (e) {}
}
Drawing._syncMiniToTs = _syncMiniToTs;

// Object is at a bar the replay hasn't reached (or before the loaded window) →
// its K-bars are placeholders/unloaded. Exit replay, then load a bounded window
// around it in live mode so the K-line + the object actually render.
async function _exitReplayAndBrowse(ts) {
  try { if (window.Replay && window.Replay.exit) await window.Replay.exit(); } catch (e) {}
  if (window.App && window.App.browseToTimestamp) {
    try { await window.App.browseToTimestamp(ts); } catch (e) {}
  } else {
    _jumpChartToTimestamp(Drawing.chart, ts);
  }
}

// Replay VIEW-ONLY scroll to `ts`: centre the object but clamp the right edge to
// just past the cursor (the last REAL bar) so the view never scrolls into the
// placeholder zone — that overshoot was what stretched/compressed the K-bars.
// Does NOT move the replay cursor (pure navigation, no record impact).
function _scrollReplayViewToTs(ts) {
  const chart = Drawing.chart, R = window.Replay;
  if (!chart || !chart.scrollToDataIndex || !Number.isFinite(ts)) return;
  const bars = (chart.getDataList && chart.getDataList()) || [];
  if (!bars.length) return;
  const objIdx = findDataIndexByTimestamp(bars, ts);
  const cursorIdx = (R && Number.isFinite(R.cursorBarIdx)) ? R.cursorBarIdx : bars.length - 1;
  const vr = chart.getVisibleRange ? chart.getVisibleRange() : null;
  const width = vr ? Math.max(10, vr.to - vr.from) : 60;
  const target = Math.min(objIdx + Math.floor(width / 2), cursorIdx + 5);
  try { chart.scrollToDataIndex(target, 0); } catch (e) {}
  _syncMiniToTs(ts);   // the mini shares the data but not the programmatic scroll
}

// Lightweight object-tree row context menu. `items` = [{ label, onClick }] —
// currently 設定… (opens the same settings dialog as the canvas right-click) and
// 跳轉至該物件位置.
function _hideTreeCtxMenu() {
  const m = document.getElementById('obj-tree-ctx');
  if (m) m.remove();
}
function _showTreeCtxMenu(pageX, pageY, items) {
  _hideTreeCtxMenu();
  const menu = document.createElement('div');
  menu.id = 'obj-tree-ctx';
  for (const it of items) {
    const item = document.createElement('div');
    item.className = 'ctx-item';
    item.textContent = it.label;
    item.addEventListener('click', () => { _hideTreeCtxMenu(); it.onClick(); });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(pageX, window.innerWidth - w - 6) + 'px';
  menu.style.top = Math.min(pageY, window.innerHeight - h - 6) + 'px';
  setTimeout(() => {
    document.addEventListener('click', _hideTreeCtxMenu, { capture: true, once: true });
    document.addEventListener('contextmenu', _hideTreeCtxMenu, { capture: true, once: true });
    window.addEventListener('blur', _hideTreeCtxMenu, { once: true });
  }, 0);
}

// =================================================================
// Position tool helpers (symbol detection + label rendering)
// =================================================================
const POSITION_PROFIT_STROKE       = '#26a69a';
const POSITION_PROFIT_FILL         = 'rgba(38, 166, 154, 0.18)';
const POSITION_PROFIT_FILL_BRIGHT  = 'rgba(38, 166, 154, 0.36)';    // triggered → emphasised
const POSITION_LOSS_STROKE         = '#ef5350';
const POSITION_LOSS_FILL           = 'rgba(239, 83, 80, 0.18)';
const POSITION_LOSS_FILL_BRIGHT    = 'rgba(239, 83, 80, 0.36)';
const POSITION_ENTRY_STROKE        = '#787b86';
const POSITION_TRIGGER_STROKE      = '#ffd54f';                     // dashed entry-trigger arrow (yellow)
const POSITION_LABEL_BG            = 'rgba(30, 34, 45, 0.94)';
const POSITION_LABEL_TEXT          = '#d1d4dc';
const POSITION_FONT_SIZE           = 12;

// ===== Fibonacci tools =====
// Default level table — 11 enabled (matching the user's TradingView screenshot)
// plus 13 extras that ship disabled so the settings panel can show them in
// the "more ratios" rows. Levels are rendered in array order; sorting for
// background banding happens at render time.
const FIBO_LEVEL_DEFAULTS = [
  { r: 0,     on: true,  color: '#787b86' },
  { r: 0.236, on: true,  color: '#f44336' },
  { r: 0.382, on: true,  color: '#ff9800' },
  { r: 0.5,   on: true,  color: '#4caf50' },
  { r: 0.618, on: true,  color: '#00897b' },
  { r: 0.786, on: true,  color: '#00bcd4' },
  { r: 1,     on: true,  color: '#cccccc' },
  { r: 1.618, on: true,  color: '#2962ff' },
  { r: 2.618, on: true,  color: '#f44336' },
  { r: 3.618, on: true,  color: '#9c27b0' },
  { r: 4.236, on: true,  color: '#e91e63' },
  // disabled extras (shown greyed out in settings)
  { r: 1.272, on: false, color: '#a98700' },
  { r: 1.414, on: false, color: '#a04040' },
  { r: 2,     on: false, color: '#00897b' },
  { r: 2.272, on: false, color: '#a98700' },
  { r: 2.414, on: false, color: '#408050' },
  { r: 3,     on: false, color: '#00897b' },
  { r: 3.272, on: false, color: '#888888' },
  { r: 3.414, on: false, color: '#5050aa' },
  { r: 4,     on: false, color: '#a04040' },
  { r: 4.272, on: false, color: '#9c27b0' },
  { r: 4.414, on: false, color: '#a02050' },
  { r: 4.618, on: false, color: '#a98700' },
  { r: 4.764, on: false, color: '#408050' },
];

// Default config seeded onto every new fibo overlay (deep-cloned per
// overlay so per-instance edits don't leak through the global).
const FIBO_CONFIG_DEFAULTS = {
  showBackground: true,
  backgroundAlpha: 0.18,
  reverse: false,
  singleColor: null,                // null = per-level colors; else hex applied to all
  trendLineColor: '#787b86',
  trendLineStyle: 'dashed',         // 'solid' | 'dashed'
  hLineStyle: 'solid',              // 'solid' | 'dashed'
  extend: 'none',                   // 'none' | 'left' | 'right' | 'both'
};

function _newFiboExtendData() {
  return {
    fibo: JSON.parse(JSON.stringify(FIBO_CONFIG_DEFAULTS)),
    levels: JSON.parse(JSON.stringify(FIBO_LEVEL_DEFAULTS)),
  };
}

// Last-used fibo config (levels/colours/reverse/background-on-off/etc),
// persisted so the NEXT fibo the user draws inherits whatever they last set up —
// via the settings panel OR by applying a template (Aaron's request). Falls back
// to the built-in defaults when nothing has been used yet.
//
// PER-FAMILY: fibo_time keeps its OWN last-used store, separate from the price
// fibos (retrace/extension). So editing a fibo_time's colours/background never
// bleeds into a new price fibo (and vice-versa), and a brand-new fibo_time with
// no history still falls back to the built-in defaults — never the Wister-tuned
// price-fibo config.
const _FIBO_LAST_USED_KEY      = 'chart_viewer.fibo_last_used';
const _FIBO_TIME_LAST_USED_KEY = 'chart_viewer.fibo_time_last_used';
function _fiboLastUsedKey(overlayName) {
  return overlayName === 'fibo_time' ? _FIBO_TIME_LAST_USED_KEY : _FIBO_LAST_USED_KEY;
}
function _saveLastUsedFibo(fibo, levels, overlayName) {
  if (!fibo || !levels) return;
  try { localStorage.setItem(_fiboLastUsedKey(overlayName), JSON.stringify({ fibo, levels })); } catch (e) {}
}
function _fiboExtendForNew(overlayName) {
  try {
    const raw = localStorage.getItem(_fiboLastUsedKey(overlayName));
    if (raw) {
      const o = JSON.parse(raw);
      if (o && o.fibo && Array.isArray(o.levels)) {
        return { fibo: JSON.parse(JSON.stringify(o.fibo)), levels: JSON.parse(JSON.stringify(o.levels)) };
      }
    }
  } catch (e) { /* fall through to defaults */ }
  return _newFiboExtendData();
}
Drawing._fiboExtendForNew = _fiboExtendForNew;
Drawing._saveLastUsedFibo = _saveLastUsedFibo;

// Seed a freshly-drawn fibo from its family's last-used config (built-in
// defaults on first use). fibo_time reads its own store, price fibos read theirs.
function _fiboSeedFor(overlayName) {
  return _fiboExtendForNew(overlayName);
}

function _fiboConfigOf(overlay) {
  // Returns { fibo: {…}, levels: [...] }. Seeds defaults if extendData is
  // empty (e.g. legacy overlays from before this tool shipped).
  if (!overlay.extendData || !overlay.extendData.fibo || !overlay.extendData.levels) {
    return _newFiboExtendData();
  }
  return overlay.extendData;
}

// Convert "#RRGGBB" or "rgba(…)" to "rgba(…)" with given alpha. Used for
// background banding between consecutive enabled levels.
function _hexToRgba(hex, alpha) {
  if (typeof hex !== 'string') return `rgba(0,0,0,${alpha})`;
  if (hex.startsWith('rgba')) {
    return hex.replace(/[\d.]+\)$/, alpha + ')');
  }
  if (hex.startsWith('rgb(')) {
    return hex.replace(/^rgb\(/, 'rgba(').replace(/\)$/, ',' + alpha + ')');
  }
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Per-overlay defaults — used at draw time to seed extendData.position.
// User can override every value via the per-overlay settings panel.
const POSITION_DEFAULT_PARAMS = {
  accountSize:  10000,    // 帳戶大小
  lotSize:      1,        // 手數大小 (contract multiplier in $/pt; user encodes)
  riskPercent:  2.0,      // 風險 %
  leverage:     1,        // 槓桿 (informational; doesn't affect math)
  tickSize:     0.25,     // for Ticks-field display
  qtyPrecision: 'default', // 'default' | 'integer' | '1'..'10'
};

function _formatPct(n) { return Number(n).toFixed(2); }
function _formatPct3(n) { return Number(n).toFixed(3); }
function _formatUSDInt(n) {
  if (!Number.isFinite(n)) return '—';
  return Math.round(Math.abs(n)).toLocaleString('en-US');
}
function _formatPositionQty(qty, qtyStep) {
  if (qtyStep >= 1) return String(Math.round(qty));
  const s = String(qtyStep);
  const dot = s.indexOf('.');
  const decimals = dot < 0 ? 0 : (s.length - dot - 1);
  return Number(qty).toFixed(decimals);
}

// Run a position's entry/target/stop simulation against historical K-bars
// inside the box's horizontal range and report the resulting state.
//
// State machine:
//   pending → no K-bar has touched the entry price yet
//   open    → a bar's range crossed the entry price (= position triggered)
//             but neither target nor stop has been hit yet
//   won     → after trigger, a bar touched the target price first → realized profit
//   stopped → after trigger, a bar touched the stop price first → realized loss
//
// "Touched" = entry price is within `[bar.low, bar.high]` (wick or body).
// The simulation skips replay placeholder bars (their flat price would lie).
function _computePositionState(overlay, side, qty, lotSize) {
  const empty = { state: 'pending', triggerBar: null, triggerIdx: -1, exitBar: null, exitIdx: -1, pl: 0 };
  // In replay mode the simulation must read Replay.displayBars, NOT
  // App.currentBars. App.currentBars holds the full historical series
  // (every bar's true high/low/close already computed), so any clip by
  // timestamp would still leak the cursor bar's *full-period* extremes.
  // Replay.displayBars is the cursor-aware view: past bars are real,
  // the in-progress bar at cursorBarIdx carries only the sub-bars the
  // user has actually played, and bars past the cursor are placeholders
  // (skipped below via the _placeholder flag).
  const replayActive = !!(window.Replay && window.Replay.active);
  const bars = (replayActive && window.Replay.displayBars && window.Replay.displayBars.length)
    ? window.Replay.displayBars
    : ((window.App && window.App.currentBars) || []);
  if (!bars.length || !overlay.points || overlay.points.length < 3) return empty;
  const points = overlay.points;
  const entryPrice  = points[0].value;
  const targetPrice = points[points.length >= 4 ? 2 : 1].value;
  const stopPrice   = points[points.length >= 4 ? 3 : 2].value;
  // Box X range: from entry-left rightwards. We don't simulate bars to the
  // LEFT of entry-left — the position "started" at that timestamp.
  const startTs = points[0].timestamp;
  const endTs = Math.max(
    points[1] ? points[1].timestamp : startTs,
    points[points.length >= 4 ? 2 : 1].timestamp,
    points[points.length >= 4 ? 3 : 2].timestamp,
  );
  const dir = side === 'long' ? 1 : -1;
  const lot = lotSize > 0 ? lotSize : 1;

  // Phase 1: find trigger bar (entry within bar range).
  let triggerIdx = -1;
  let triggerBar = null;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar._placeholder) continue;
    if (bar.timestamp < startTs) continue;
    if (bar.timestamp > endTs) break;
    if (Number.isFinite(bar.low) && Number.isFinite(bar.high)
        && entryPrice >= bar.low && entryPrice <= bar.high) {
      triggerIdx = i;
      triggerBar = bar;
      break;
    }
  }
  if (triggerIdx < 0) {
    // No trigger — pending. Still return live P/L against the last bar
    // before endTs as a "what-if" (matches the prior behavior).
    let last = null;
    for (const bar of bars) {
      if (bar.timestamp > endTs) break;
      if (bar.timestamp >= startTs && !bar._placeholder) last = bar;
    }
    const pl = (last && Number.isFinite(last.close) && qty > 0)
      ? dir * (last.close - entryPrice) * qty * lot : 0;
    return { ...empty, pl };
  }

  // Phase 2: scan forward for whichever of target/stop is hit first. If both
  // fall within the same bar's range it's ambiguous — assume the worse case
  // (stop, so the user doesn't get a falsely optimistic preview).
  // Track running max/min through the scan so the win/stopped return can
  // also report the price excursion up to (and including) the exit bar.
  {
    let mxH = -Infinity, mxHBar = null;
    let mnL =  Infinity, mnLBar = null;
    // Include the trigger bar itself in the extreme scan.
    if (Number.isFinite(triggerBar.high)) { mxH = triggerBar.high; mxHBar = triggerBar; }
    if (Number.isFinite(triggerBar.low))  { mnL = triggerBar.low;  mnLBar = triggerBar; }
    for (let i = triggerIdx + 1; i < bars.length; i++) {
      const bar = bars[i];
      if (bar._placeholder) continue;
      if (bar.timestamp > endTs) break;
      if (Number.isFinite(bar.high) && bar.high > mxH) { mxH = bar.high; mxHBar = bar; }
      if (Number.isFinite(bar.low)  && bar.low  < mnL) { mnL = bar.low;  mnLBar = bar;  }
      let hitTarget, hitStop;
      if (side === 'long') {
        hitTarget = bar.high >= targetPrice;
        hitStop   = bar.low  <= stopPrice;
      } else {
        hitTarget = bar.low  <= targetPrice;
        hitStop   = bar.high >= stopPrice;
      }
      if (hitTarget && hitStop) {
        const pl = -1 * Math.abs(entryPrice - stopPrice) * qty * lot;
        return { state: 'stopped', triggerBar, triggerIdx, exitBar: bar, exitIdx: i, pl,
                 maxHigh: mxH, maxHighBar: mxHBar, minLow: mnL, minLowBar: mnLBar, lastBar: bar };
      }
      if (hitTarget) {
        const pl = +1 * Math.abs(targetPrice - entryPrice) * qty * lot;
        return { state: 'won', triggerBar, triggerIdx, exitBar: bar, exitIdx: i, pl,
                 maxHigh: mxH, maxHighBar: mxHBar, minLow: mnL, minLowBar: mnLBar, lastBar: bar };
      }
      if (hitStop) {
        const pl = -1 * Math.abs(entryPrice - stopPrice) * qty * lot;
        return { state: 'stopped', triggerBar, triggerIdx, exitBar: bar, exitIdx: i, pl,
                 maxHigh: mxH, maxHighBar: mxHBar, minLow: mnL, minLowBar: mnLBar, lastBar: bar };
      }
    }
  }

  // Phase 3: triggered but still open. P/L = (last bar close - entry) × qty.
  // Also collect the extremes (max high / min low) seen since trigger so the
  // renderer can draw a progressive highlight + an arrow to the extreme.
  let last = triggerBar;
  let maxHigh = -Infinity, maxHighBar = null;
  let minLow  =  Infinity, minLowBar  = null;
  for (let i = triggerIdx; i < bars.length; i++) {
    const bar = bars[i];
    if (bar._placeholder) continue;
    if (bar.timestamp > endTs) break;
    last = bar;
    if (Number.isFinite(bar.high) && bar.high > maxHigh) { maxHigh = bar.high; maxHighBar = bar; }
    if (Number.isFinite(bar.low)  && bar.low  < minLow)  { minLow  = bar.low;  minLowBar  = bar;  }
  }
  const pl = (last && qty > 0) ? dir * (last.close - entryPrice) * qty * lot : 0;
  return {
    state: 'open',
    triggerBar, triggerIdx, exitBar: null, exitIdx: -1, pl,
    maxHigh, maxHighBar, minLow, minLowBar, lastBar: last,
  };
}

// Pull params off the overlay (extendData.position) with defaults filled in.
// New overlays seed with PositionConfig values for accountSize / riskPercent.
function _getPositionParams(overlay) {
  const stored = (overlay && overlay.extendData && overlay.extendData.position) || {};
  const cfg = window.PositionConfig || {};
  return {
    accountSize:  Number.isFinite(+stored.accountSize)  ? +stored.accountSize  : (cfg.account_size || POSITION_DEFAULT_PARAMS.accountSize),
    lotSize:      Number.isFinite(+stored.lotSize)      ? +stored.lotSize      : POSITION_DEFAULT_PARAMS.lotSize,
    riskPercent:  Number.isFinite(+stored.riskPercent)  ? +stored.riskPercent  : (cfg.default_risk_percent || POSITION_DEFAULT_PARAMS.riskPercent),
    leverage:     Number.isFinite(+stored.leverage)     ? +stored.leverage     : POSITION_DEFAULT_PARAMS.leverage,
    tickSize:     Number.isFinite(+stored.tickSize)     ? +stored.tickSize     : POSITION_DEFAULT_PARAMS.tickSize,
    qtyPrecision: stored.qtyPrecision || POSITION_DEFAULT_PARAMS.qtyPrecision,
  };
}

// Convert a "#rrggbb" hex (or any rgba()) string to rgba(r, g, b, alpha).
// Used so per-overlay colors picked from the 樣式 tab can be re-applied at
// the muted base / bright highlight / not-selected fade alphas without
// asking the user for each variant.
function _withAlpha(color, alpha) {
  if (!color) return `rgba(120, 123, 134, ${alpha})`;
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const m = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
  return color;
}

// Defaults for the per-overlay 樣式 tab. Anything missing from
// overlay.extendData.position.styles falls back to one of these.
const POSITION_STYLE_DEFAULTS = {
  lineColor:     '#ffd54f',     // entry middle line + trigger arrow + extreme arrow
  lineOpacity:   1,             // 0–1; multiplied with the line stroke alpha
  targetColor:   '#26a69a',     // target stroke / fill / label text
  targetOpacity: 1,             // 0–1; multiplied with stroke alpha + zone fill alpha
  stopColor:     '#ef5350',     // stop stroke / fill / label text
  stopOpacity:   1,
  fontSize:      12,
  showPriceLabel: true,         // false → hide the 目標 / 停損 corner labels
};

function _getPositionStyles(overlay) {
  const stored = (overlay && overlay.extendData && overlay.extendData.position
                  && overlay.extendData.position.styles) || {};
  return { ...POSITION_STYLE_DEFAULTS, ...stored };
}

// Build figures (one rect bg + one text) for a label centered horizontally
// on `centerX` and anchored above/below/on `anchorY` (or directly on it for
// 'center'). `accentColor` colors the text; the bg stays dark for readability.
function _buildPositionLabel(centerX, anchorY, position, text, accentColor, bgOverride, fontSize) {
  const fs    = fontSize || POSITION_FONT_SIZE;
  const padX  = 8;
  const padY  = 4;
  const lineH = fs + 4;
  const bgColor = bgOverride || POSITION_LABEL_BG;
  // Multi-line support — split on '\n' so the center label can wrap into a
  // more square-shaped box.
  const lines = String(text).split('\n');

  // Approximate text width (KLineChart figures don't expose measureText here).
  let maxW = 0;
  for (const ln of lines) {
    let w = 0;
    for (const ch of ln) {
      w += /[\u4e00-\u9fff]/.test(ch) ? fs * 1.0 : fs * 0.55;
    }
    if (w > maxW) maxW = w;
  }
  const boxW = maxW + padX * 2;
  const boxH = lines.length * lineH + padY * 2;

  let boxY;
  if (position === 'above')      boxY = anchorY - boxH - 2;
  else if (position === 'below') boxY = anchorY + 2;
  else                            boxY = anchorY - boxH / 2;   // 'center'
  const boxX = centerX - boxW / 2;

  const figs = [{
    type: 'rect',
    attrs: { x: boxX, y: boxY, width: boxW, height: boxH },
    styles: { style: 'fill', color: bgColor, borderRadius: 3 },
  }];
  for (let i = 0; i < lines.length; i++) {
    figs.push({
      type: 'text',
      attrs: {
        x: centerX,
        y: boxY + padY + i * lineH + lineH / 2,
        text: lines[i],
        align: 'center',
        baseline: 'middle',
      },
      styles: {
        color: accentColor || POSITION_LABEL_TEXT,
        size: fs,
        family: '"Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif',
        backgroundColor: 'transparent',
        borderColor: 'transparent',
        borderSize: 0,
        paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
      },
    });
  }
  return figs;
}

// Build the full figure list for a long/short position overlay. `side` is
// 'long' or 'short' — used for label-position direction (target side of
// entry depends on side) and to know which arrow direction is "expected".
function _buildPositionFigures(coordinates, overlay, side) {
  if (!coordinates || coordinates.length < 1) return [];

  // Box left/right X = bounds of all currently-known points so dragging any
  // handle widens/narrows the box naturally.
  let leftX  = coordinates[0].x;
  let rightX = coordinates[0].x;
  for (const c of coordinates) {
    if (c.x < leftX)  leftX  = c.x;
    if (c.x > rightX) rightX = c.x;
  }
  if (rightX - leftX < 2) rightX = leftX + 2;   // guard zero-width during 1st click

  // Layout-aware index mapping. New positions use 4 points (entry-left,
  // entry-right, target, stop); legacy 3-point overlays still render via
  // the old mapping (entry, target, stop).
  const isFourPoint = coordinates.length >= 4;
  const entryY  = coordinates[0].y;
  const targetIdx = isFourPoint ? 2 : 1;
  const stopIdx   = isFourPoint ? 3 : 2;
  const figures = [];

  // Run the simulation early so zone colors / labels can react to its state.
  const points = overlay.points || [];
  const fourPt = points.length >= 4;
  const tIdx = fourPt ? 2 : 1;
  const sIdx = fourPt ? 3 : 2;
  let result = null;
  let state = { state: 'pending', triggerBar: null, triggerIdx: -1, exitBar: null, exitIdx: -1, pl: 0 };
  let params = null;
  if (points.length >= 3 && window.PositionCalc) {
    params = _getPositionParams(overlay);
    try {
      result = window.PositionCalc.calcSimple({
        entryPrice: points[0].value,
        targetPrice: points[tIdx].value,
        stopPrice: points[sIdx].value,
        accountSize: params.accountSize,
        lotSize: params.lotSize,
        riskPercent: params.riskPercent,
        tickSize: params.tickSize,
        qtyPrecision: params.qtyPrecision,
      });
      if (result) {
        state = _computePositionState(overlay, side, result.qty, params.lotSize);
      }
    } catch (e) {
      console.warn('[position] calc failed', e);
    }
  }
  // Per-overlay user colors (from 樣式 tab) with sensible defaults. When the
  // overlay isn't currently selected, fade the fills slightly so the K-bars
  // under the position stay readable — Selected → 0.20 / 0.36; unselected
  // → 0.14 / 0.28. The user-picked OPACITY from each color's slider is
  // multiplied through every alpha so dragging the slider down dims both
  // the line strokes and the zone fills proportionally (default 1.0 keeps
  // existing behavior).
  const styles = _getPositionStyles(overlay);
  const isSelected = !!(Drawing.selectedOverlay && Drawing.selectedOverlay.id === overlay.id);
  const baseAlpha   = isSelected ? 0.20 : 0.14;
  const brightAlpha = isSelected ? 0.36 : 0.28;
  const lineStroke   = _withAlpha(styles.lineColor,   styles.lineOpacity);
  const targetStroke = _withAlpha(styles.targetColor, styles.targetOpacity);
  const stopStroke   = _withAlpha(styles.stopColor,   styles.stopOpacity);
  const profitFill       = _withAlpha(styles.targetColor, baseAlpha   * styles.targetOpacity);
  const profitFillBright = _withAlpha(styles.targetColor, brightAlpha * styles.targetOpacity);
  const lossFill         = _withAlpha(styles.stopColor,   baseAlpha   * styles.stopOpacity);
  const lossFillBright   = _withAlpha(styles.stopColor,   brightAlpha * styles.stopOpacity);

  // Invisible thick hit-area lines — KLineChart's native click/select
  // path picks these up the same as a 1px visible stroke, so the user can
  // wake the position by clicking the entry middle line OR any of the
  // four box borders (not just the small handles).
  const HIT_TRANSPARENT = 'rgba(0, 0, 0, 0.001)';
  const HIT_SIZE = 14;
  const _pushHit = (a, b) => figures.push({
    type: 'line',
    attrs: { coordinates: [a, b] },
    styles: { color: HIT_TRANSPARENT, size: HIT_SIZE, style: 'solid' },
  });

  // Compute target/stop Y up front so we can lay out hit lines before the
  // visible figures. Either may be missing on first click.
  const targetY = (coordinates.length > targetIdx) ? coordinates[targetIdx].y : null;
  const stopY   = (coordinates.length > stopIdx)   ? coordinates[stopIdx].y   : null;

  if (targetY != null && stopY != null) {
    const boxTop = Math.min(targetY, stopY);
    const boxBot = Math.max(targetY, stopY);
    _pushHit({ x: leftX,  y: boxTop }, { x: rightX, y: boxTop });   // top frame
    _pushHit({ x: leftX,  y: boxBot }, { x: rightX, y: boxBot });   // bottom frame
    _pushHit({ x: leftX,  y: boxTop }, { x: leftX,  y: boxBot });   // left frame
    _pushHit({ x: rightX, y: boxTop }, { x: rightX, y: boxBot });   // right frame
  }
  _pushHit({ x: leftX, y: entryY }, { x: rightX, y: entryY });      // center line

  // Profit zone (entry → target).
  if (targetY != null) {
    const top = Math.min(entryY, targetY);
    const bot = Math.max(entryY, targetY);
    figures.push({
      type: 'rect',
      attrs: { x: leftX, y: top, width: rightX - leftX, height: bot - top },
      styles: { style: 'fill', color: profitFill },
    });
    figures.push({
      type: 'line',
      attrs: { coordinates: [{ x: leftX, y: targetY }, { x: rightX, y: targetY }] },
      styles: { color: targetStroke, size: 1, style: 'solid' },
    });
  }

  // Loss zone (entry → stop).
  if (stopY != null) {
    const top = Math.min(entryY, stopY);
    const bot = Math.max(entryY, stopY);
    figures.push({
      type: 'rect',
      attrs: { x: leftX, y: top, width: rightX - leftX, height: bot - top },
      styles: { style: 'fill', color: lossFill },
    });
    figures.push({
      type: 'line',
      attrs: { coordinates: [{ x: leftX, y: stopY }, { x: rightX, y: stopY }] },
      styles: { color: stopStroke, size: 1, style: 'solid' },
    });
  }

  // Entry middle line — uses the user-picked 線條 color (matches the
  // diagonal trigger / extreme arrows below). Drawn after zone fills so
  // it sits on top of them.
  figures.push({
    type: 'line',
    attrs: { coordinates: [{ x: leftX, y: entryY }, { x: rightX, y: entryY }] },
    styles: {
      color: lineStroke, size: 1, style: 'dashed', dashedValue: [5, 4],
    },
  });

  // Trigger arrow + bright highlight + extreme arrow — only after the
  // position has triggered. ONE diagonal dashed line from the trigger bar
  // (= where price first crossed entry, the actual entry point on the
  // chart) to the most meaningful price excursion since. The bright
  // highlight rect mirrors the dashed line's bounding box, so the lit
  // zone always tracks where the line points and never extends past it.
  if (state.triggerBar && Drawing.chart && Drawing.chart.convertToPixel) {
    try {
      const toPx = (ts, v) => {
        const out = Drawing.chart.convertToPixel(
          [{ timestamp: ts, value: v }], { paneId: 'candle_pane' });
        return Array.isArray(out) ? out[0] : null;
      };

      // 1. Horizontal trigger arrow along the entry price line:
      //    entry-left → trigger bar. Marks where on the timeline price
      //    actually first touched entry.
      const tb = toPx(state.triggerBar.timestamp, points[0].value);
      if (tb && Number.isFinite(tb.x)) {
        figures.push({
          type: 'line',
          attrs: { coordinates: [
            { x: coordinates[0].x, y: entryY },
            { x: tb.x, y: entryY },
          ] },
          styles: {
            color: lineStroke, size: 1, style: 'dashed', dashedValue: [4, 3],
          },
        });
        figures.push({
          type: 'circle',
          attrs: { x: tb.x, y: entryY, r: 3 },
          styles: { style: 'fill', color: lineStroke },
        });

        // 2. Pick where the diagonal dashed arrow points to.
        //    Rule (user spec): the tip tracks the LATEST K-bar's wick
        //    (its high or low, depending on which side of entry it sits)
        //    — NOT the historic max/min over the whole scan. The only
        //    exception: if price already crossed target or stop, the tip
        //    locks to that frame line at the bar where it was touched.
        const entryPrice  = points[0].value;
        const targetPrice = points[tIdx].value;
        const stopPrice   = points[sIdx].value;
        const dir = side === 'long' ? 1 : -1;
        const lastBar = state.lastBar || state.triggerBar;

        let extremeBar = null;
        let extremePrice = null;
        let useFavorable = null;
        if (state.state === 'won') {
          // Reached target → pin the tip on the target line at exit X.
          extremeBar = lastBar;
          extremePrice = targetPrice;
          useFavorable = true;
        } else if (state.state === 'stopped') {
          // Reached stop → pin on the stop line at exit X.
          extremeBar = lastBar;
          extremePrice = stopPrice;
          useFavorable = false;
        } else if (lastBar) {
          // Still open. Direction = favorable side IF that wick has crossed
          // entry; otherwise fall back to the adverse wick. Picking by wick
          // (not by close) keeps the dashed arrow stable across sub-TF
          // replay ticks: the in-progress bar's high/low only widen as
          // ticks come in, so once "favorable" wins it can't flip back —
          // close-based direction would flicker every time price touched
          // entry mid-bar and the bright zone would jump up/down.
          const high = lastBar.high;
          const low  = lastBar.low;
          if (dir > 0) {
            // long: high above entry = favorable, low below = adverse
            if (Number.isFinite(high) && high > entryPrice) {
              extremeBar = lastBar; extremePrice = high; useFavorable = true;
            } else if (Number.isFinite(low) && low < entryPrice) {
              extremeBar = lastBar; extremePrice = low;  useFavorable = false;
            }
          } else {
            // short: low below entry = favorable, high above = adverse
            if (Number.isFinite(low) && low < entryPrice) {
              extremeBar = lastBar; extremePrice = low;  useFavorable = true;
            } else if (Number.isFinite(high) && high > entryPrice) {
              extremeBar = lastBar; extremePrice = high; useFavorable = false;
            }
          }
        }

        if (useFavorable !== null && extremeBar && Number.isFinite(extremePrice)) {
          // Safety clamp: if the latest wick happens to overshoot the box
          // frame even though the state machine hasn't flipped, snap the
          // tip exactly onto target/stop so the marker dot stays on-frame.
          if (useFavorable) {
            extremePrice = (dir > 0)
              ? Math.min(extremePrice, targetPrice)
              : Math.max(extremePrice, targetPrice);
          } else {
            extremePrice = (dir > 0)
              ? Math.max(extremePrice, stopPrice)
              : Math.min(extremePrice, stopPrice);
          }

          if (extremeBar) {
            const exPx = toPx(extremeBar.timestamp, extremePrice);
            if (exPx && Number.isFinite(exPx.x) && Number.isFinite(exPx.y)) {
              // 3. Bright highlight — mirrors the dashed line's bounding
              //    box. X = [trigger.x, extreme.x], Y = [entry, clamped
              //    extreme]. Only ONE side lights up (the side the line
              //    points to), and only as far as the line reaches.
              const brightLeft  = Math.min(tb.x, exPx.x);
              const brightRight = Math.max(tb.x, exPx.x);
              const brightTop   = Math.min(entryY, exPx.y);
              const brightBot   = Math.max(entryY, exPx.y);
              if (brightRight > brightLeft && brightBot > brightTop) {
                figures.push({
                  type: 'rect',
                  attrs: { x: brightLeft, y: brightTop,
                           width: brightRight - brightLeft,
                           height: brightBot - brightTop },
                  styles: { style: 'fill',
                    color: useFavorable ? profitFillBright : lossFillBright },
                });
              }

              // 4. Diagonal extreme arrow — starts at the trigger bar
              //    (the actual entry point on the chart, not the box's
              //    left edge), ends at the clamped extreme.
              figures.push({
                type: 'line',
                attrs: { coordinates: [
                  { x: tb.x, y: entryY },
                  { x: exPx.x, y: exPx.y },
                ] },
                styles: {
                  color: lineStroke, size: 1, style: 'dashed', dashedValue: [4, 3],
                },
              });
              figures.push({
                type: 'circle',
                attrs: { x: exPx.x, y: exPx.y, r: 3 },
                styles: { style: 'fill', color: lineStroke },
              });
            }
          }
        }
      }
    } catch (e) { /* convertToPixel might fail on first render — silent */ }
  }

  // Stats labels — only when calc succeeded above.
  if (result) {
    // Label format matches TradingView Chinese style:
    //   目標 : 57.75 (0.219%) 231, 金額 : 40800
    //   停損 : 57.75 (0.219%) 231, 金額 : 9800
    //   {未平倉|已平倉}損益表 : pl, 數量 : qty / 風險/報酬比 : rr
    // Spec i18n §3.7 — position overlay labels routed through the
    // dictionary: panel.position.target / .stop / .amount / .qty /
    // .rrRatio + .unrealized / .realized for the open vs closed
    // P/L caption.
    const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
    const targetText =
      `${t_('panel.position.target')} : ${_formatPct(result.targetPoints)} (${_formatPct3(result.targetPct)}%) ` +
      `${result.targetTicks}, ${t_('panel.position.amount')} : ${_formatUSDInt(result.targetUSD)}`;
    const stopText =
      `${t_('panel.position.stop')} : ${_formatPct(result.stopPoints)} (${_formatPct3(result.stopPct)}%) ` +
      `${result.stopTicks}, ${t_('panel.position.amount')} : ${_formatUSDInt(result.stopUSD)}`;
    const qtyStr = _formatPositionQty(result.qty, result.qtyStep);
    const isClosed = state.state === 'won' || state.state === 'stopped';
    const labelPrefix = isClosed ? t_('panel.position.realized') : t_('panel.position.unrealized');
    const pl = state.pl;
    // Center text follows the corresponding zone color so the user's
    // 目標/停損 picks flow through to the P/L line as well — profit reads
    // in target color (with the user's targetOpacity), loss reads in
    // stop color, zero stays neutral.
    const plColor = pl > 0
      ? targetStroke
      : pl < 0 ? stopStroke : POSITION_LABEL_TEXT;
    const plStr = (pl >= 0 ? '' : '-') + Math.abs(pl).toFixed(2);
    // Two-line center label so the box is roughly square instead of a long
    // ribbon. Line break uses '\n' which _buildPositionLabel splits.
    const infoText =
      `${labelPrefix} : ${plStr}, ${t_('panel.position.qty')} : ${qtyStr}\n${t_('panel.position.rrRatio')} : ${_formatPct(result.rrRatio)}`;

    const cx = (leftX + rightX) / 2;

    // Target/stop corner labels — toggleable via the 樣式 tab (價格標籤).
    // Each tracks its zone's color so adjusting 目標顏色 / 停損顏色 also
    // recolors the matching label text immediately.
    if (styles.showPriceLabel && targetY != null) {
      const targetAbove = targetY < entryY;
      figures.push(..._buildPositionLabel(
        cx, targetY, targetAbove ? 'above' : 'below',
        targetText, targetStroke, undefined, styles.fontSize));
    }
    if (styles.showPriceLabel && stopY != null) {
      const stopBelow = stopY > entryY;
      figures.push(..._buildPositionLabel(
        cx, stopY, stopBelow ? 'below' : 'above',
        stopText, stopStroke, undefined, styles.fontSize));
    }

    // Center P/L label — bg fades to translucent when the overlay isn't
    // selected so the K-bars under it stay readable. Clicking the entry
    // line OR any of the four box borders re-selects (the invisible hit
    // lines added at the top of figures cover all five surfaces).
    const centerBg = isSelected
      ? POSITION_LABEL_BG
      : 'rgba(30, 34, 45, 0.30)';
    figures.push(..._buildPositionLabel(
      cx, entryY, 'center', infoText, plColor, centerBg, styles.fontSize));
  }

  return figures;
}

// Auto-fill target & stop after the user's single click. Called from setTool's
// onDrawEnd hook for long/short position overlays.
function _autoFillPositionPoints(overlay, side, chart) {
  if (!overlay || !overlay.points || overlay.points.length === 0) return;
  // Chart the position was dropped on (main by default; the mini when a
  // position is drawn there). All geometry + the overrideOverlay must target
  // THIS chart, else a mini position's target/stop auto-fill silently no-ops
  // against a non-existent main-chart id.
  chart = chart || Drawing.chart;
  const entry = overlay.points[0];
  const entryPrice = entry.value;
  const entryTs = entry.timestamp;

  // Sizing: reuse the last RR-applied point distances (so a fresh position
  // inherits the stop/target the user last dialed in via 依停損設定目標 /
  // 依目標設定停損). Falls back to a symmetric 0.5%-of-entry offset (= R:R 1)
  // when nothing has been remembered yet.
  const offset = Math.max(Math.abs(entryPrice) * 0.005, 1);
  const remembered = _loadLastPositionSizing();
  const stopPts   = (remembered && remembered.stopPoints   > 0) ? remembered.stopPoints   : offset;
  const targetPts = (remembered && remembered.targetPoints > 0) ? remembered.targetPoints : offset;

  // Long: target above entry, stop below. Short flips.
  const targetPrice = side === 'long' ? entryPrice + targetPts : entryPrice - targetPts;
  const stopPrice   = side === 'long' ? entryPrice - stopPts   : entryPrice + stopPts;

  // Box right-edge timestamp = ~30% of visible bar count to the right.
  const bars = (chart && chart.getDataList && chart.getDataList())
    || (window.App && window.App.currentBars) || [];
  let rightTs = entryTs;
  try {
    const vis = chart && chart.getVisibleRange && chart.getVisibleRange();
    if (vis) {
      const visW = (vis.to - vis.from) || 50;
      const widthBars = Math.max(10, Math.round(visW * 0.3));
      const clickIdx = findDataIndexByTimestamp(bars, entryTs);
      if (Number.isFinite(clickIdx)) {
        const rightIdx = Math.min(bars.length - 1, clickIdx + widthBars);
        if (bars[rightIdx]) rightTs = bars[rightIdx].timestamp;
      }
    }
  } catch (e) { /* fall back to entryTs (zero-width) */ }
  if (rightTs === entryTs && bars.length) {
    // Last-resort fallback: use entry timestamp + display TF * 30 bars
    const tfMs = (window.Replay && window.Replay.displayTfMs) || 60000;
    rightTs = entryTs + tfMs * 30;
  }

  // Seed per-overlay params from PositionConfig + sensible defaults. The user
  // can edit every value in the per-overlay settings panel.
  const cfg = window.PositionConfig || {};
  const positionParams = {
    accountSize:  cfg.account_size           || POSITION_DEFAULT_PARAMS.accountSize,
    lotSize:      POSITION_DEFAULT_PARAMS.lotSize,
    riskPercent:  cfg.default_risk_percent   || POSITION_DEFAULT_PARAMS.riskPercent,
    leverage:     POSITION_DEFAULT_PARAMS.leverage,
    tickSize:     POSITION_DEFAULT_PARAMS.tickSize,
    qtyPrecision: POSITION_DEFAULT_PARAMS.qtyPrecision,
  };

  // 4-point layout: entry-left + entry-right define box width on the entry
  // line; target/stop are anchored to entry-left's X so they sit on the LEFT
  // edge initially. When the user mirror-flips the box (drags one entry past
  // the other), target/stop stay on entry-left's anchor — so they appear on
  // the right edge after the flip without needing extra logic.
  //   [0] entry-left   (leftX,  entry_y)
  //   [1] entry-right  (rightX, entry_y)   ← Y synced with [0]
  //   [2] target       (leftX,  target_y)  ← X synced to entry-left
  //   [3] stop         (leftX,  stop_y)    ← X synced to entry-left
  const newPoints = [
    { timestamp: entryTs, value: entryPrice },
    { timestamp: rightTs, value: entryPrice },
    { timestamp: entryTs, value: targetPrice },
    { timestamp: entryTs, value: stopPrice },
  ];
  try {
    chart.overrideOverlay({
      id: overlay.id,
      points: newPoints,
      extendData: { ...(overlay.extendData || {}), position: positionParams },
    });
    overlay.points = newPoints;
    overlay.extendData = { ...(overlay.extendData || {}), position: positionParams };
  } catch (e) {
    console.warn('[position] auto-fill failed', e);
  }
}
Drawing._autoFillPositionPoints = _autoFillPositionPoints;

// Last RR-applied position sizing (stop/target distances in price points),
// persisted so the NEXT freshly-dropped position inherits the same points —
// same idea as the fibo last-used config. Global (not per-symbol), matching
// the fibo pattern; distances are absolute price points.
const _POSITION_LAST_RR_KEY = 'chart_viewer.position_last_rr';
function _saveLastPositionSizing(stopPoints, targetPoints) {
  if (!(stopPoints > 0) || !(targetPoints > 0)) return;
  try { localStorage.setItem(_POSITION_LAST_RR_KEY, JSON.stringify({ stopPoints, targetPoints })); } catch (e) {}
}
function _loadLastPositionSizing() {
  try {
    const o = JSON.parse(localStorage.getItem(_POSITION_LAST_RR_KEY) || 'null');
    if (o && o.stopPoints > 0 && o.targetPoints > 0) return o;
  } catch (e) {}
  return null;
}

// ---------------------------------------------------------------------------
// Set target-from-stop (or stop-from-target) by a risk/reward ratio.
// Right-click a position box → 依停損設定目標 / 依目標設定停損 → RrPopup asks
// for an R:R, and we recompute the chosen leg keeping entry + the OTHER leg
// fixed. Direction is derived from the price geometry, so it's long/short
// agnostic:
//   RR = |target − entry| / |entry − stop|
//   set-target: newTarget = entry + (entry − stop) × RR
//   set-stop:   newStop   = entry − (target − entry) / RR
// Points layout mirrors _buildPositionFigures: 4-pt = [entry, entryR, target,
// stop]; legacy 3-pt = [entry, target, stop].
function _positionRRIdx(pts) {
  const fourPt = pts.length >= 4;
  return { targetIdx: fourPt ? 2 : 1, stopIdx: fourPt ? 3 : 2 };
}
function _currentPositionRR(overlay) {
  const pts = overlay && overlay.points;
  if (!pts || pts.length < 3) return null;
  const { targetIdx, stopIdx } = _positionRRIdx(pts);
  const entry = pts[0].value, target = pts[targetIdx].value, stop = pts[stopIdx].value;
  const sp = Math.abs(entry - stop);
  if (!(sp > 0) || !Number.isFinite(target)) return null;
  return Math.abs(target - entry) / sp;
}
// Pure — returns { idx, newValue } for the leg to move, or null.
function _positionRRResult(overlay, mode, rr) {
  const pts = overlay && overlay.points;
  if (!pts || pts.length < 3) return null;
  const { targetIdx, stopIdx } = _positionRRIdx(pts);
  const entry = pts[0].value;
  if (!Number.isFinite(entry) || !Number.isFinite(rr) || rr <= 0) return null;
  if (mode === 'stop') {
    const target = pts[targetIdx].value;
    if (!Number.isFinite(target)) return null;
    return { idx: stopIdx, newValue: entry - (target - entry) / rr };
  }
  const stop = pts[stopIdx].value;
  if (!Number.isFinite(stop)) return null;
  return { idx: targetIdx, newValue: entry + (entry - stop) * rr };
}
function _applyPositionRR(overlay, mode, rr) {
  const res = _positionRRResult(overlay, mode, rr);
  if (!res) return;
  const chart = _chartOf(overlay.id) || Drawing.chart;
  const before = overlay.points.map(p => ({ ...p }));
  const after  = before.map(p => ({ ...p }));
  after[res.idx] = { ...after[res.idx], value: res.newValue };
  const commit = (arr) => {
    overlay.points = arr.map(p => ({ ...p }));
    try { chart.overrideOverlay({ id: overlay.id, points: overlay.points }); } catch (e) {}
    updateTrackedOverlay(overlay.id, { points: overlay.points });
  };
  commit(after);
  // Remember this sizing so the next new position inherits the same points.
  const pts = overlay.points;
  const { targetIdx, stopIdx } = _positionRRIdx(pts);
  const e2 = pts[0].value;
  _saveLastPositionSizing(Math.abs(e2 - pts[stopIdx].value), Math.abs(e2 - pts[targetIdx].value));
  pushUndo({ label: 'position R:R', undo: () => commit(before), redo: () => commit(after) });
}

// TradingView-style R:R input popup — mirrors the tf-popup (app.js) behaviour:
// big centred input, Enter commits, Esc / click-outside cancels. Reuses the
// tf-popup CSS classes. Digit + single '.' buffer (R:R may be fractional).
const RrPopup = {
  buffer: '', overlay: null, mode: 'target',
  _t(k, f) { return (window.I18n && window.I18n.t) ? (window.I18n.t(k) || f) : f; },
  open(overlay, mode) {
    if (!overlay) return;
    this.overlay = overlay;
    this.mode = mode === 'stop' ? 'stop' : 'target';
    const rr = _currentPositionRR(overlay);
    this.buffer = (rr && Number.isFinite(rr)) ? String(Math.round(rr * 100) / 100) : '';
    const titleEl = document.getElementById('rr-popup-title');
    if (titleEl) titleEl.textContent = this.mode === 'target'
      ? this._t('dlg.rrPopupTitleTarget', '依停損設定目標')
      : this._t('dlg.rrPopupTitleStop', '依目標設定停損');
    const pop = document.getElementById('rr-popup');
    if (pop) pop.classList.remove('hidden');
    this.render();
  },
  hide() {
    const pop = document.getElementById('rr-popup');
    if (pop) { pop.classList.add('hidden'); pop.classList.remove('invalid'); }
    this.buffer = ''; this.overlay = null;
  },
  isOpen() {
    const pop = document.getElementById('rr-popup');
    return !!pop && !pop.classList.contains('hidden');
  },
  render() {
    const pop = document.getElementById('rr-popup');
    if (!pop) return;
    const rr = parseFloat(this.buffer);
    const valid = this.buffer !== '' && Number.isFinite(rr) && rr > 0;
    pop.classList.toggle('invalid', !valid);
    const inp = document.getElementById('rr-popup-input');
    if (inp) inp.textContent = this.buffer || '';
    const subEl = document.getElementById('rr-popup-sub');
    if (!subEl) return;
    if (valid && this.overlay) {
      const res = _positionRRResult(this.overlay, this.mode, rr);
      if (res) {
        const lbl = this.mode === 'target'
          ? this._t('dlg.rrTargetLabel', '目標')
          : this._t('dlg.rrStopLabel', '停損');
        subEl.textContent = `RR ${Math.round(rr * 100) / 100} → ${lbl} ${res.newValue.toFixed(2)}`;
        return;
      }
    }
    subEl.textContent = this._t('dlg.rrHint', '風報比（大於 0）');
  },
  commit() {
    const rr = parseFloat(this.buffer);
    if (!Number.isFinite(rr) || rr <= 0) return;
    _applyPositionRR(this.overlay, this.mode, rr);
    this.hide();
  },
  // Registered in CAPTURE phase so it beats app.js's bubble-phase keydown
  // (which would otherwise open the tf-popup / symbol search on a digit).
  handleKey(e) {
    if (!this.isOpen()) return;
    if (e.key === 'Enter')     { this.commit(); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Escape')    { this.hide();   e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Backspace') { this.buffer = this.buffer.slice(0, -1); this.render(); e.preventDefault(); e.stopPropagation(); return; }
    if (/^[0-9]$/.test(e.key)) { this.buffer += e.key; this.render(); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === '.' && !this.buffer.includes('.')) { this.buffer += '.'; this.render(); e.preventDefault(); e.stopPropagation(); return; }
    e.stopPropagation();   // swallow the rest so no other popup hijacks focus
  },
};
Drawing.RrPopup = RrPopup;

// While the user is dragging one of the 4 default-point handles on a long/
// short position, axis-lock per-handle:
//   • entry-left (idx 0) / entry-right (idx 1) — X only (Y locked to entry
//     price). Both middle handles + target/stop translate together — drag
//     one entry handle moves the entire box horizontally as a rigid unit.
//   • target (idx 2) / stop (idx 3) — Y only (X locked to current edge).
//
// The "translate together" sync uses `overrideOverlay` because direct
// mutation of `event.points[i]` (for i ≠ performPointIndex) doesn't appear
// to propagate to KLineChart's render pipeline.
// `event.overlay` is NOT provided by this KLineChart build — the callback
// gets {currentStep, mode, points, performPointIndex, performPoint} only.
// We pass `side` ('long' | 'short') via closure.
//
// CRITICAL: KLineChart updates points[performPointIndex] to the cursor's
// position BEFORE this callback fires. So `points[idx]` already has the
// "new" cursor coords — using it as a "lock" reference doesn't lock anything.
// The fix: lock against another (stable) point that the user isn't dragging.
//   • Middle handles (idx 0/1)  → lock Y against the OTHER entry handle's Y.
//   • Top/bottom (idx 2/3)      → lock X against the rightmost entry handle.
function _enforcePositionConstraints(event, side) {
  if (!event || !event.performPoint) return;
  const idx = event.performPointIndex;
  const points = event.points;
  if (typeof idx !== 'number' || !points || points.length < 4) return;
  const pp = event.performPoint;

  if (idx === 0 || idx === 1) {
    // Middle handles — X-only RESIZE; Y locked to the OTHER entry's value.
    const otherIdx = idx === 0 ? 1 : 0;
    const lockedY = points[otherIdx].value;
    pp.value = lockedY;
    // Target/stop are ANCHORED to entry-left (idx 0). When entry-left moves,
    // target/stop X follows so they stay glued to that side. When entry-right
    // moves, target/stop X stays — they remain anchored where they were.
    if (idx === 0) {
      points[2].timestamp = pp.timestamp;
      points[2].dataIndex = pp.dataIndex;
      points[3].timestamp = pp.timestamp;
      points[3].dataIndex = pp.dataIndex;
    }
  } else if (idx === 2 || idx === 3) {
    // Top/bottom handles — Y-only. Lock X to entry-left (points[0]) — the
    // anchor target/stop are glued to. After a mirror flip entry-left ends
    // up on the right side of the box, and target/stop go with it.
    pp.timestamp = points[0].timestamp;
    pp.dataIndex = points[0].dataIndex;
  }
}

// Force every long/short position overlay to re-render (called from
// app.js after PositionConfig saves so the figures pick up new Qty/P/L).
function refreshPositionOverlays() {
  if (!Drawing.chart) return;
  for (const [id, entry] of Drawing.overlayRegistry) {
    if (entry.name === 'long_position' || entry.name === 'short_position') {
      try {
        // Empty patch is enough — KLineChart re-runs createPointFigures.
        Drawing.chart.overrideOverlay({ id });
      } catch (e) { /* ignore */ }
    }
  }
  // Mini-drawn positions live on the mini chart + _miniRegistry — refresh them
  // on their own chart so a PositionConfig save updates Qty/P/L there too.
  const miniChart = window.MiniChart && window.MiniChart.chart;
  if (miniChart && Drawing._miniRegistry) {
    for (const e of Drawing._miniRegistry.values()) {
      if ((e.name === 'long_position' || e.name === 'short_position') && e._ovid) {
        try { miniChart.overrideOverlay({ id: e._ovid }); } catch (err) { /* ignore */ }
      }
    }
  }
}
Drawing.refreshPositionOverlays = refreshPositionOverlays;

// =================================================================
// Measure tool helpers (tick size / duration / volume / label build)
// =================================================================
// Tick sizes per symbol (points per tick). Default 1 for unknown symbols —
// revisit when we have a real symbol-metadata layer.
const TICK_SIZES = {
  NQ1: 0.25,
  TXF1: 1,
};
function _measureTickSize() {
  const sym = (window.App && window.App.currentSymbol) || '';
  return TICK_SIZES[sym] || 1;
}

function _formatSignedDuration(ms) {
  const neg = ms < 0;
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86400000);
  const h = Math.floor((abs % 86400000) / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  // Duration suffixes — zh "X 日 H 小時 M 分" / en "Xd Hh Mm".
  // Not in spec §3 master dictionary; inline because measure-tool
  // text needs to fit a compact label.
  const lang = (window.I18n && window.I18n.lang) || 'zh';
  const dSfx = lang === 'en' ? 'd'  : '日';
  const hSfx = lang === 'en' ? 'h'  : '小時';
  const mSfx = lang === 'en' ? 'm'  : '分';
  const parts = [];
  if (d) parts.push(d + dSfx);
  if (h) parts.push(h + hSfx);
  if (m || !parts.length) parts.push(m + mSfx);
  return (neg ? '-' : '') + parts.join(' ');
}

function _formatVolume(v) {
  const abs = Math.abs(v);
  const sgn = v < 0 ? '-' : '';
  if (abs >= 1e9) return sgn + (abs / 1e9).toFixed(2) + ' B';
  if (abs >= 1e6) return sgn + (abs / 1e6).toFixed(2) + ' M';
  if (abs >= 1e3) return sgn + (abs / 1e3).toFixed(2) + ' K';
  return sgn + String(Math.round(abs));
}

function _sumVolumeBetween(tsA, tsB) {
  const bars = (window.App && window.App.currentBars) || [];
  const lo = Math.min(tsA, tsB);
  const hi = Math.max(tsA, tsB);
  let sum = 0;
  for (const bar of bars) {
    if (bar.timestamp >= lo && bar.timestamp <= hi) sum += (bar.volume || 0);
  }
  return sum;
}

// Find the bar's index in currentBars whose timestamp is closest-not-past ts.
function _barIndexAtOrBefore(ts) {
  const bars = (window.App && window.App.currentBars) || [];
  let lo = 0, hi = bars.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp <= ts) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

// Build a triangle polygon for an arrowhead with tip at (tipX, tipY).
function _measureArrowHead(tipX, tipY, dir, size) {
  const w = size * 0.7;
  switch (dir) {
    case 'right': return [{ x: tipX, y: tipY }, { x: tipX - size, y: tipY - w }, { x: tipX - size, y: tipY + w }];
    case 'left':  return [{ x: tipX, y: tipY }, { x: tipX + size, y: tipY - w }, { x: tipX + size, y: tipY + w }];
    case 'up':    return [{ x: tipX, y: tipY }, { x: tipX - w, y: tipY + size }, { x: tipX + w, y: tipY + size }];
    case 'down':  return [{ x: tipX, y: tipY }, { x: tipX - w, y: tipY - size }, { x: tipX + w, y: tipY - size }];
  }
  return [];
}

// ---- Curve (曲線) geometry helpers ----
// Sample a quadratic Bézier P0→C→P2 into `n` segments (n+1 points). The curve
// tool stores 3 handles: start, APEX (on the curve), end. We want the drawn
// curve to pass THROUGH the apex M at t=0.5, so the Bézier control point is
// C = 2M − (P0+P2)/2 (solving B(0.5)=M).
function _curveControl(p0, m, p2) {
  return { x: 2 * m.x - (p0.x + p2.x) / 2, y: 2 * m.y - (p0.y + p2.y) / 2 };
}
function _sampleQuadratic(p0, c, p2, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push({
      x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y,
    });
  }
  return pts;
}
// Tangent (unit vector) of the quadratic at t∈{0,1}: B'(t)=2(1-t)(C-P0)+2t(P2-C).
function _curveTangent(p0, c, p2, t) {
  const dx = 2 * (1 - t) * (c.x - p0.x) + 2 * t * (p2.x - c.x);
  const dy = 2 * (1 - t) * (c.y - p0.y) + 2 * t * (p2.y - c.y);
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}
// Triangle arrowhead with tip at (tx,ty) pointing along unit vector (ux,uy).
function _curveArrowHead(tx, ty, ux, uy, size) {
  const w = size * 0.55;
  const bx = tx - ux * size, by = ty - uy * size;   // base center behind the tip
  const nx = -uy, ny = ux;                          // perpendicular
  return [{ x: tx, y: ty }, { x: bx + nx * w, y: by + ny * w }, { x: bx - nx * w, y: by - ny * w }];
}

// Selection handles (blue anchor dots) emitted from createPointFigures when the
// overlay is the selected one. KLineChart's own default point figures only show
// on a CANVAS selection, so overlays that rely on them (curve / trendline /
// position) render NO handles when selected from the object tree. These match the
// default handle style + sit on the same anchor coordinates, so on a canvas click
// the two overlap invisibly, while a tree click still shows them. `ignoreEvent`
// keeps them out of hit-testing (the real draggable handles are KLineChart's).
function _selectionHandleFigures(coordinates) {
  return (coordinates || [])
    .filter(c => c && Number.isFinite(c.x) && Number.isFinite(c.y))
    .map(c => ({
      type: 'circle', ignoreEvent: true,
      attrs: { x: c.x, y: c.y, r: 4 },
      styles: { style: 'stroke_fill', color: '#2962ff', borderColor: '#fff', borderSize: 1 },
    }));
}

// Curve is drawn with 2 clicks (A=start, C=end); this seeds the middle apex B so
// the curve is BORN with a bow (never a straight line). B sits at the chord
// midpoint pushed perpendicular (downward on screen) by a fraction of the chord
// length, computed in PIXEL space so the bow looks consistent at any scale, then
// converted back to a data point. The user drags B afterwards to reshape.
function _seedCurveApex(a, c, chart) {
  // Compute the bow in the TARGET chart's pixel space (default main). Passing
  // the mini chart lets the curve tool auto-seed the apex on the mini too, so a
  // mini curve is 2-click (A,C)+bow just like the main — not native 3-click.
  chart = chart || Drawing.chart;
  if (!chart) return null;
  try {
    const toPx = (p) => {
      const out = chart.convertToPixel([{ timestamp: p.timestamp, dataIndex: p.dataIndex, value: p.value }], { paneId: 'candle_pane' });
      return Array.isArray(out) ? out[0] : out;
    };
    const pa = toPx(a), pc = toPx(c);
    if (!pa || !pc || !Number.isFinite(pa.x) || !Number.isFinite(pc.x)) return null;
    const dx = pc.x - pa.x, dy = pc.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    let px = -dy / len, py = dx / len;                 // unit perpendicular
    if (py < 0) { px = -px; py = -py; }                // bow downward (screen +y)
    const bow = Math.min(120, Math.max(34, len * 0.22));
    const mx = (pa.x + pc.x) / 2 + px * bow;
    const my = (pa.y + pc.y) / 2 + py * bow;
    const out = chart.convertFromPixel({ x: mx, y: my }, { paneId: 'candle_pane' });
    const b = Array.isArray(out) ? out[0] : out;
    if (!b || !Number.isFinite(b.value)) return null;
    const apex = { value: b.value };
    if (Number.isFinite(b.dataIndex)) apex.dataIndex = b.dataIndex;
    if (Number.isFinite(b.timestamp)) apex.timestamp = b.timestamp;
    else if (Number.isFinite(a.timestamp) && Number.isFinite(c.timestamp)) apex.timestamp = (a.timestamp + c.timestamp) / 2;
    return [a, apex, c];
  } catch (e) { return null; }
}

// Build the 3-line stats text for a measure overlay. Values are signed based
// on the start-to-end direction: dragging rightward = positive bars/time,
// dragging upward = positive price change.
function _buildMeasureLabel(overlay) {
  const points = overlay.points || [];
  if (points.length < 2) return ['—'];
  const p1 = points[0], p2 = points[1];

  const priceDiff = (p2.value || 0) - (p1.value || 0);
  const pricePct = p1.value ? (priceDiff / p1.value * 100) : 0;
  const tickSize = _measureTickSize();
  const tickCount = tickSize > 0 ? Math.round(priceDiff / tickSize) : 0;

  const tsDiff = (p2.timestamp || 0) - (p1.timestamp || 0);
  const idx1 = _barIndexAtOrBefore(p1.timestamp);
  const idx2 = _barIndexAtOrBefore(p2.timestamp);
  const barCount = (idx1 >= 0 && idx2 >= 0) ? (idx2 - idx1) : 0;

  // Volume always unsigned (sum of magnitudes between the two timestamps).
  const volume = _sumVolumeBetween(p1.timestamp, p2.timestamp);

  const fmt2 = (n) => (n >= 0 ? '' : '-') + Math.abs(n).toFixed(2);
  const fmtI = (n) => (n >= 0 ? '' : '-') + Math.abs(n);

  // Bar count + volume captions — inline per-locale (not in spec §3).
  const lang = (window.I18n && window.I18n.lang) || 'zh';
  const barsSfx = lang === 'en' ? ' bars' : '根K棒';
  const volLabel = lang === 'en' ? 'Vol' : '成交量';
  return [
    `${fmt2(priceDiff)} (${fmt2(pricePct)}%) ${fmtI(tickCount)}`,
    `${fmtI(barCount)}${barsSfx}, ${_formatSignedDuration(tsDiff)}`,
    `${volLabel} ${_formatVolume(volume)}`,
  ];
}

// Measure horizontal half-width (px) of the gap we need to cut out of the
// horizontal crosshair line around the center text, so the stroke doesn't
// slash through the glyphs.
function _measureHorizLineGapHalf(textState) {
  if (!textState || !textState.content) return 0;
  const fs = textState.size || 14;
  const text = String(textState.content).split('\n')[0] || '';  // single line on the crosshair
  let w = 0;
  for (const ch of text) {
    w += /[\u4e00-\u9fff]/.test(ch) ? fs * 1.0 : fs * 0.6;
  }
  return (w / 2) + 8;  // +8 px padding on each side
}

// Vertical half-height of the text's gap on the vertical crosshair line.
// Text rendered with baseline:'middle' is ~1em tall — add a small padding.
function _measureVertLineGapHalf(textState) {
  if (!textState || !textState.content) return 0;
  const fs = textState.size || 14;
  return (fs / 2) + 4;  // +4 px padding top/bottom
}

// Figures for the center-of-crosshair user text. Defaults (no custom color
// set) follow the crosshair color so the label reads as part of the same
// visual accent. Background and border are forced transparent so KLineChart
// doesn't render its default text-figure chip behind the glyphs.
function _measureCenterTextFigures(cx, cy, textState, defaultColor) {
  const fs = textState.size || 14;
  const col = (textState.color && textState.color.hex) || defaultColor || '#2962ff';
  const alpha = (textState.color && typeof textState.color.opacity === 'number')
    ? textState.color.opacity : 1;
  const weight = textState.bold ? 'bold' : 'normal';
  const italic = textState.italic ? 'italic ' : '';
  return [{
    type: 'text',
    attrs: { x: cx, y: cy, text: textState.content, align: 'center', baseline: 'middle' },
    styles: {
      color: _hexToRgbaLite(col, alpha),
      size: fs,
      weight,
      family: `${italic}"Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif`,
      backgroundColor: 'transparent',
      borderColor: 'transparent',
      borderSize: 0,
      paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
    },
  }];
}

// Small hex→rgba used by measure helpers (bigger hexToRgba is defined later).
function _hexToRgbaLite(hex, a) {
  if (!hex || hex.startsWith('rgb')) return hex || '#d1d4dc';
  const m = hex.replace('#', '');
  const n = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${a})`;
}

// Build KLineChart figures for a stats label positioned above or below a
// given anchor Y, horizontally centered at centerX.
function _measureLabelFigures(centerX, anchorY, position, lines, labelSty) {
  const bg       = (labelSty && labelSty.bg)       || 'rgba(30,34,45,0.92)';
  const textCol  = (labelSty && labelSty.text)     || '#d1d4dc';
  const fontSize = (labelSty && labelSty.fontSize) || 13;
  const lineH = fontSize + 6;
  const padX = 12, padY = 8;

  // Approximate text width — KLineChart figures don't expose measureText here.
  // Chinese glyphs are ~1.0 em, ASCII ~0.55 em; use a middle estimate.
  let maxW = 0;
  for (const line of lines) {
    let w = 0;
    for (const ch of line) {
      w += /[\u4e00-\u9fff]/.test(ch) ? fontSize * 1.0 : fontSize * 0.6;
    }
    if (w > maxW) maxW = w;
  }
  const boxW = maxW + padX * 2;
  const boxH = lines.length * lineH + padY * 2;
  const boxX = centerX - boxW / 2;
  const boxY = position === 'above' ? (anchorY - boxH) : anchorY;

  const figs = [{
    type: 'rect',
    attrs: { x: boxX, y: boxY, width: boxW, height: boxH },
    styles: { style: 'fill', color: bg, borderRadius: 4 },
  }];
  for (let i = 0; i < lines.length; i++) {
    figs.push({
      type: 'text',
      attrs: {
        x: centerX,
        y: boxY + padY + i * lineH + lineH / 2,
        text: lines[i],
        align: 'center',
        baseline: 'middle',
      },
      styles: {
        color: textCol, size: fontSize,
        family: '"Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif',
        backgroundColor: 'transparent',
        borderColor: 'transparent',
        borderSize: 0,
        paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
      },
    });
  }
  return figs;
}

// ===== Custom overlay templates (registered once) =====
// Style strategy: figures read styles directly from the overlay's `styles` field so
// that `chart.overrideOverlay({id, styles: {...}})` can mutate appearance live.
function registerOverlays() {
  // Custom figure that respects italic in its style string — KLineChart's
  // built-in `text` figure only honors size/weight/family and drops the
  // italic bit, so bold+italic on rect labels needs this.
  try {
    klinecharts.registerFigure({
      name: 'rectLabel',
      draw: (ctx, attrs, styles) => {
        ctx.save();
        const italic = styles.italic ? 'italic ' : '';
        const weight = styles.weight || 400;
        const size = styles.size || 14;
        const family = styles.family || 'sans-serif';
        ctx.font = `${italic}${weight} ${size}px ${family}`;
        ctx.fillStyle = styles.color || '#FFFFFF';
        ctx.textAlign = attrs.align || 'left';
        ctx.textBaseline = attrs.baseline || 'top';
        // Rotation support (used for trendline labels that follow line slope).
        if (attrs.rotation) {
          ctx.translate(attrs.x, attrs.y);
          ctx.rotate(attrs.rotation);
          ctx.fillText(attrs.text, 0, 0);
        } else {
          ctx.fillText(attrs.text, attrs.x, attrs.y);
        }
        ctx.restore();
      },
      checkEventOn: () => false,
    });
  } catch (e) { /* already registered (HMR) */ }

  // Given the two line endpoints and a text that sits ON the line (vPos='inside'),
  // return 0-2 line segments so the line doesn't pass through the text's glyphs.
  function breakTrendlineAroundText(p1, p2, textState, lineStyles) {
    const t = { ...DEFAULT_TEXT_STATE, ...(textState || {}) };
    const pL = p1.x <= p2.x ? p1 : p2;
    const pR = p1.x <= p2.x ? p2 : p1;
    const dx = pR.x - pL.x, dy = pR.y - pL.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return [{ type: 'line', attrs: { coordinates: [p1, p2] }, styles: lineStyles }];
    const ux = dx / len, uy = dy / len;

    // Measure text width in the same font we'll render with
    const ctx = _textMeasureCtx();
    const italic = t.italic ? 'italic ' : '';
    const weight = t.bold ? 900 : 400;
    ctx.font = `${italic}${weight} ${t.size}px "Noto Sans SC", sans-serif`;
    const textWidth = ctx.measureText(t.content.replace(/\r?\n/g, ' ')).width;

    // Match the anchor logic in buildTrendlineTextFigures.
    const edgePad = 8;
    let textLeft, textRight;
    if (t.hAlign === 'left') {
      textLeft = edgePad;
      textRight = textLeft + textWidth;
    } else if (t.hAlign === 'right') {
      textRight = len - edgePad;
      textLeft = textRight - textWidth;
    } else {
      textLeft = len / 2 - textWidth / 2;
      textRight = len / 2 + textWidth / 2;
    }

    const gapPad = 6;      // visual breathing room on each side of the text
    const gapL = Math.max(0, textLeft - gapPad);
    const gapR = Math.min(len, textRight + gapPad);

    const figs = [];
    if (gapL > 2) {
      figs.push({
        type: 'line',
        attrs: { coordinates: [pL, { x: pL.x + ux * gapL, y: pL.y + uy * gapL }] },
        styles: lineStyles,
      });
    }
    if (gapR < len - 2) {
      figs.push({
        type: 'line',
        attrs: { coordinates: [{ x: pL.x + ux * gapR, y: pL.y + uy * gapR }, pR] },
        styles: lineStyles,
      });
    }
    return figs;
  }

  // ----- Trendline text label builder (rotates to match line slope) -----
  function buildTrendlineTextFigures(p1, p2, textState) {
    const t = { ...DEFAULT_TEXT_STATE, ...(textState || {}) };
    if (!t.content) return [];
    // Always orient the baseline left-to-right so `angle` stays in [-π/2, π/2]
    // (text never flips upside down) and "above" is always toward smaller y.
    const pL = p1.x <= p2.x ? p1 : p2;
    const pR = p1.x <= p2.x ? p2 : p1;
    const dx = pR.x - pL.x;
    const dy = pR.y - pL.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return [];
    const ux = dx / len, uy = dy / len;
    const angle = Math.atan2(dy, dx);      // in [-π/2, π/2] because dx>=0
    // Perpendicular pointing "up" in screen: (+uy, -ux) since dx>=0 → -ux<=0
    const perpX = uy, perpY = -ux;

    // Anchor along the line per hAlign. Small edge padding so text doesn't
    // hit the endpoint circles.
    const edgePad = 8;
    let anchorX, anchorY, align;
    if (t.hAlign === 'left') {
      anchorX = pL.x + ux * edgePad;
      anchorY = pL.y + uy * edgePad;
      align = 'left';
    } else if (t.hAlign === 'right') {
      anchorX = pR.x - ux * edgePad;
      anchorY = pR.y - uy * edgePad;
      align = 'right';
    } else {
      anchorX = (pL.x + pR.x) / 2;
      anchorY = (pL.y + pR.y) / 2;
      align = 'center';
    }

    // Perpendicular offset per vPos.
    const perpPad = 4;
    let offset, baseline;
    if (t.vPos === 'top') {         // above the line
      offset = perpPad;
      baseline = 'bottom';
    } else if (t.vPos === 'bottom') {   // below the line
      offset = -perpPad;
      baseline = 'top';
    } else {                        // on the line (inside / middle)
      offset = 0;
      baseline = 'middle';
    }
    const x = anchorX + perpX * offset;
    const y = anchorY + perpY * offset;

    // Join newlines with space — trendline text is typically single-line.
    const text = t.content.replace(/\r?\n/g, ' ');
    const color = hexToRgba(t.color.hex, t.color.opacity);
    return [{
      type: 'rectLabel',
      attrs: { x, y, text, align, baseline, rotation: angle },
      styles: {
        color, size: t.size,
        family: '"Noto Sans SC", sans-serif',
        weight: t.bold ? 900 : 400,
        italic: !!t.italic,
      },
    }];
  }

  // ----- Trendline with snap -----
  klinecharts.registerOverlay({
    name: 'trendline_snap',
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    styles: {
      line: { color: '#2962ff', size: 1, style: 'solid' },
      point: { color: '#2962ff', borderColor: '#fff', borderSize: 1, radius: 4 },
    },
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length < 2) return [];
      const lineStyles = (overlay.styles && overlay.styles.line) || {};
      const textState = overlay.extendData && overlay.extendData.text;
      const isSelected = Drawing.selectedOverlay && Drawing.selectedOverlay.id === overlay.id;
      // Either hit-test counts: KLineChart's own hover OR our wider custom one.
      const isHovered = _hoveredOverlayId === overlay.id || _trendlineHoverId === overlay.id;
      const isDragging = _overlayDrag || !!_rectDrag;
      const isDrawing = Drawing.drawingId === overlay.id;
      const isEditing = _trendEditingId === overlay.id;

      // Decide whether a text sits ON the line (and therefore should split the
      // line into two segments so glyphs aren't crossed by a stroke). Suppress
      // while inline-editing — the textarea owns the display.
      const hasOnLineText = !isEditing && textState && textState.content &&
        (!textState.vPos || textState.vPos === 'inside');
      const showPlaceholder = !isEditing && !(textState && textState.content)
        && isSelected && isHovered && !isDragging && !isDrawing;

      const figs = [];
      // Invisible thick hit-test line in front — gives KLineChart a wide
      // selectable surface (for left-click select, right-click, pressed-move
      // drag) without changing the visible line thickness.
      const hitSize = Math.max((lineStyles.size || 1) + 10, 14);
      figs.push({
        type: 'line',
        attrs: { coordinates: [coordinates[0], coordinates[1]] },
        styles: { color: 'rgba(0,0,0,0.001)', size: hitSize, style: 'solid' },
      });

      // i18n placeholder strings — read at render time so language
      // toggles flip the trendline ghost text on the next repaint.
      const _addText = (window.I18n && window.I18n.t)
        ? window.I18n.t('tool.addText') : '+ 新增文字';
      const _addTextEditing = (window.I18n && window.I18n.t)
        ? window.I18n.t('tool.addTextEditing') : '新增文字';
      if (isEditing && _trendEditingState) {
        // While inline-editing, break the line around the *live* typed content
        // (or the editing placeholder as a minimum-width string when the
        // buffer is empty).
        const editGhost = {
          ...DEFAULT_TEXT_STATE, ..._trendEditingState,
          content: _trendEditingState.content || _addTextEditing,
          hAlign: 'center', vPos: 'inside',
        };
        figs.push(...breakTrendlineAroundText(coordinates[0], coordinates[1], editGhost, lineStyles));
      } else if (hasOnLineText) {
        figs.push(...breakTrendlineAroundText(coordinates[0], coordinates[1], textState, lineStyles));
      } else if (showPlaceholder) {
        // Placeholder is always on-line + centered → also break the line.
        const base = textState || DEFAULT_TEXT_STATE;
        const ghost = { ...DEFAULT_TEXT_STATE, ...base, content: _addText, hAlign: 'center', vPos: 'inside' };
        figs.push(...breakTrendlineAroundText(coordinates[0], coordinates[1], ghost, lineStyles));
      } else {
        figs.push({ type: 'line', attrs: { coordinates: [coordinates[0], coordinates[1]] }, styles: lineStyles });
      }

      if (!isEditing) {
        if (textState && textState.content) {
          figs.push(...buildTrendlineTextFigures(coordinates[0], coordinates[1], textState));
        } else if (showPlaceholder) {
          const base = textState || DEFAULT_TEXT_STATE;
          const ghostColor = { ...(base.color || DEFAULT_TEXT_STATE.color) };
          ghostColor.opacity = 0.6;
          figs.push(...buildTrendlineTextFigures(coordinates[0], coordinates[1],
            { ...DEFAULT_TEXT_STATE, ...base, content: _addText,
              color: ghostColor, hAlign: 'center', vPos: 'inside' }));
        }
      }
      // Selection handles at both endpoints so a tree-click shows the trendline
      // as selected (KLineChart's default handles only appear on a canvas click).
      if (isSelected) figs.push(..._selectionHandleFigures([coordinates[0], coordinates[1]]));
      return figs;
    },
    performEventMoveForDrawing: applySnap,
    performEventPressedMove: (event) => { setGlobalCursor('grabbing'); applySnap(event); },
    ...overlayInteractions,
  });

  // ----- Curve (曲線) — 3 points: start, apex, end -----
  // A quadratic Bézier that passes THROUGH the middle handle (apex). Optional
  // arrowheads on either end and straight tangent extensions past either end
  // (TradingView "curve" tool). Params live in extendData.curve:
  //   { arrowLeft, arrowRight, extendLeft, extendRight }  (all bool, default false)
  klinecharts.registerOverlay({
    name: 'curve_snap',
    totalStep: 4,                       // 3 clicks + finalize
    needDefaultPointFigure: true,       // draggable handles at each stored point
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    styles: {
      line: { color: '#2962ff', size: 1, style: 'solid' },
      point: { color: '#2962ff', borderColor: '#fff', borderSize: 1, radius: 4 },
    },
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length < 2) return [];
      const lineStyles = (overlay.styles && overlay.styles.line) || {};
      const cd = (overlay.extendData && overlay.extendData.curve) || {};
      const figs = [];

      // Three points → quadratic through the real apex. Two points (mid-draw
      // preview) → quadratic through a SYNTHETIC bowed apex, so the curve already
      // shows curvature while dragging A→C (visually distinct from a trendline).
      // The bow matches _seedCurveApex (pixel space here) so the preview and the
      // committed 3-point curve line up.
      let poly, tanStart, tanEnd, pStart, pEnd;
      let m;
      if (coordinates.length >= 3) {
        m = coordinates[1];
      } else {
        const [p0, p2] = coordinates;
        const dx = p2.x - p0.x, dy = p2.y - p0.y, len = Math.hypot(dx, dy) || 1;
        let nx = -dy / len, ny = dx / len;            // unit perpendicular
        if (ny < 0) { nx = -nx; ny = -ny; }           // bow downward (screen +y)
        const bow = Math.min(120, Math.max(34, len * 0.22));
        m = { x: (p0.x + p2.x) / 2 + nx * bow, y: (p0.y + p2.y) / 2 + ny * bow };
      }
      {
        const p0 = coordinates[0], p2 = coordinates[coordinates.length >= 3 ? 2 : 1];
        const c = _curveControl(p0, m, p2);
        poly = _sampleQuadratic(p0, c, p2, 48);
        tanStart = _curveTangent(p0, c, p2, 0);   // points p0→c
        tanEnd = _curveTangent(p0, c, p2, 1);     // points c→p2
        pStart = p0; pEnd = p2;
      }

      // Wide invisible hit-line through the whole polyline (native line hit-test
      // is ~3px; give select / right-click / drag a fat surface).
      const hitSize = Math.max((lineStyles.size || 1) + 10, 14);
      figs.push({ type: 'line', attrs: { coordinates: poly }, styles: { color: 'rgba(0,0,0,0.001)', size: hitSize, style: 'solid' } });

      // Straight tangent extensions past either end, out to the pane edge.
      const EXT = 100000;   // long enough to always exit the visible pane
      if (cd.extendLeft) {
        figs.push({ type: 'line', styles: lineStyles,
          attrs: { coordinates: [pStart, { x: pStart.x - tanStart.x * EXT, y: pStart.y - tanStart.y * EXT }] } });
      }
      if (cd.extendRight) {
        figs.push({ type: 'line', styles: lineStyles,
          attrs: { coordinates: [pEnd, { x: pEnd.x + tanEnd.x * EXT, y: pEnd.y + tanEnd.y * EXT }] } });
      }

      // The visible curve.
      figs.push({ type: 'line', attrs: { coordinates: poly }, styles: lineStyles });

      // Arrowheads on the ends (outward-pointing along the tangents).
      const aSize = Math.max((lineStyles.size || 1) * 3 + 5, 9);
      const aColor = lineStyles.color || '#2962ff';
      if (cd.arrowRight) {
        figs.push({ type: 'polygon',
          attrs: { coordinates: _curveArrowHead(pEnd.x, pEnd.y, tanEnd.x, tanEnd.y, aSize) },
          styles: { style: 'fill', color: aColor } });
      }
      if (cd.arrowLeft) {
        figs.push({ type: 'polygon',
          attrs: { coordinates: _curveArrowHead(pStart.x, pStart.y, -tanStart.x, -tanStart.y, aSize) },
          styles: { style: 'fill', color: aColor } });
      }
      // Selection handles at the 3 real anchors (start / apex / end) so the curve
      // shows as selected from an object-tree click, not just a canvas click.
      const isSel = Drawing.selectedOverlay && Drawing.selectedOverlay.id === overlay.id;
      if (isSel && coordinates.length >= 3) {
        figs.push(..._selectionHandleFigures([coordinates[0], coordinates[1], coordinates[2]]));
      }
      return figs;
    },
    performEventMoveForDrawing: applySnap,
    performEventPressedMove: (event) => { setGlobalCursor('grabbing'); applySnap(event); },
    ...overlayInteractions,
  });

  // ----- Rectangle with snap + 8 drag handles (4 corners + 4 edges) -----
  // KLineChart v9 has no built-in rectangle; this custom overlay renders the
  // rect body plus 8 circle handles. performEventPressedMove uses figureIndex
  // (position in createPointFigures' return list) to decide which side(s) of
  // the stored pts[0]/pts[1] to mutate.
  // Match trendline/path default point style: blue fill + white border.
  const HANDLE_STYLE = {
    style: 'stroke_fill',
    color: '#2962ff',
    borderColor: '#fff',
    borderSize: 1,
  };

  // Build text figures that wrap to fit `maxWidth`. Returns 0+ figures.
  // Breaks on whitespace when possible; falls back to per-char wrap if a single
  // token is too long (handles narrow rects with long words like "BBOSS").
  // Positions lines based on vPos (top/inside/bottom) × hAlign (left/center/right).
  // wrap=true → soft-wrap each paragraph to the box width (rectangle labels,
  // and text boxes with 自動換行 ON). wrap=false → keep each explicit line as-is
  // (text boxes with 自動換行 OFF — the box is auto-sized to fit instead).
  // insideTop=true (text boxes) anchors the text at the box's TOP-LEFT INSIDE
  // corner with padding, matching the inline editor. Rectangle/trendline labels
  // use vPos ('top' renders ABOVE the box, the title convention).
  function buildRectTextFigures(box, textState, wrap = true, insideTop = false) {
    const t = { ...DEFAULT_TEXT_STATE, ...(textState || {}) };
    if (!t.content) return [];
    const maxWidth = Math.max(8, box.x2 - box.x1 - 8);   // 4px padding each side
    const weight = t.bold ? 900 : 400;                    // Black = 900
    const fontFamily = '"Noto Sans SC", sans-serif';
    const font = `${t.italic ? 'italic ' : ''}${weight} ${t.size}px ${fontFamily}`;
    const ctx = _textMeasureCtx();
    ctx.font = font;

    // Wrap each explicit newline independently, then soft-wrap each to maxWidth.
    const lines = [];
    for (const para of t.content.split(/\r?\n/)) {
      if (!para) { lines.push(''); continue; }
      if (wrap) lines.push(...wrapLine(ctx, para, maxWidth));
      else      lines.push(para);
    }

    const lineHeight = Math.ceil(t.size * 1.2);
    const totalH = lineHeight * lines.length;
    const pad = 4;
    // Each line's y is the VERTICAL CENTER of its line box, and we draw with
    // `baseline: 'middle'`. This matches how textareas position glyphs inside
    // a line-height box, so the inline editor and the final rendered label
    // sit on the exact same baseline.
    let firstCenterY;
    if (insideTop) {
      firstCenterY = box.y1 + pad + lineHeight / 2;                 // text box: top-left inside
    } else if (t.vPos === 'top') {
      firstCenterY = box.y1 - pad - totalH + lineHeight / 2;
    } else if (t.vPos === 'bottom') {
      firstCenterY = box.y2 + pad + lineHeight / 2;
    } else {
      firstCenterY = (box.y1 + box.y2) / 2 - totalH / 2 + lineHeight / 2;
    }
    const baseline = 'middle';
    // Horizontal anchor x + align per hAlign.
    let anchorX, align;
    if (t.hAlign === 'left')       { anchorX = box.x1 + pad; align = 'left'; }
    else if (t.hAlign === 'right') { anchorX = box.x2 - pad; align = 'right'; }
    else                           { anchorX = (box.x1 + box.x2) / 2; align = 'center'; }

    const color = hexToRgba(t.color.hex, t.color.opacity);
    const figs = [];
    lines.forEach((line, i) => {
      if (!line) return;
      figs.push({
        type: 'rectLabel',
        attrs: { x: anchorX, y: firstCenterY + i * lineHeight, text: line, align, baseline },
        styles: {
          color,
          size: t.size,
          family: '"Noto Sans SC", sans-serif',
          weight: t.bold ? 900 : 400,
          italic: !!t.italic,
        },
      });
    });
    return figs;
  }

  klinecharts.registerOverlay({
    name: 'rectangle_snap',
    totalStep: 3,
    needDefaultPointFigure: false,              // we draw our own handles
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    styles: {
      rect: {
        style: 'stroke_fill',
        color: 'rgba(41,98,255,0.12)',
        borderColor: '#2962ff',
        borderSize: 1,
      },
      point: { color: '#2962ff', borderColor: '#fff', borderSize: 1, radius: 4 },
    },
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length < 2) return [];
      const [p1, p2] = coordinates;
      const x1 = Math.min(p1.x, p2.x);
      const x2 = Math.max(p1.x, p2.x);
      const y1 = Math.min(p1.y, p2.y);
      const y2 = Math.max(p1.y, p2.y);
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const ed = overlay.extendData || {};
      const isTextBox = !!ed.textBox;
      const textState = ed.text;
      const isDrawing = Drawing.drawingId === overlay.id;
      const isSelected = Drawing.selectedOverlay && Drawing.selectedOverlay.id === overlay.id;
      const isEditing = _rectEditingId === overlay.id;

      const figures = [];
      // A text box draws its background/border only when the user opts in
      // (extendData.bgEnabled / borderEnabled); by default it's just text.
      // A normal rectangle always draws its rect (unchanged path).
      if (!isTextBox) {
        figures.push({ type: 'rect', attrs: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
          styles: (overlay.styles && overlay.styles.rect) || {} });
      } else {
        const bgOn = !!ed.bgEnabled, bdOn = !!ed.borderEnabled;
        // ALWAYS draw a fill rect — with a transparent color when the user hasn't
        // enabled a background. A transparent FILL is invisible but still
        // hit-tested (checkEventOn is geometric), so the whole text box body is
        // clickable / right-clickable and click-away can deselect it. Without
        // this, a no-background text box has no canvas target at all and is only
        // reachable through the object tree (Aaron's report).
        figures.push({ type: 'rect', attrs: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
          styles: {
            style: bdOn ? 'stroke_fill' : 'fill',
            color: bgOn ? hexToRgba((ed.bgColor && ed.bgColor.hex) || '#1e222d',
                                    ed.bgColor ? ed.bgColor.opacity : 0.85) : 'transparent',
            borderColor: bdOn ? hexToRgba((ed.borderColor && ed.borderColor.hex) || '#2962ff',
                                          ed.borderColor ? ed.borderColor.opacity : 1) : 'transparent',
            borderSize: 1,
          } });
      }
      // Text label. For a text box the wrap flag comes from extendData.wrap;
      // rectangle labels always wrap to the box width. Stored in extendData.text.
      // While THIS overlay is in inline-edit mode, skip text + placeholder — the
      // textarea owns the display.
      const wrapText = isTextBox ? !!ed.wrap : true;
      if (!isEditing) {
        if (textState && textState.content) {
          figures.push(...buildRectTextFigures({ x1, y1, x2, y2 }, textState, wrapText, isTextBox));
        } else if (isSelected) {
          const base = textState || DEFAULT_TEXT_STATE;
          const ghostColor = { ...(base.color || DEFAULT_TEXT_STATE.color) };
          ghostColor.opacity = 0.5;
          const _addText = (window.I18n && window.I18n.t)
            ? window.I18n.t('tool.addText') : '+ 新增文字';
          figures.push(...buildRectTextFigures({ x1, y1, x2, y2 },
            { ...DEFAULT_TEXT_STATE, ...base, content: _addText, color: ghostColor }, wrapText, isTextBox));
        }
      }
      if (isDrawing || isSelected) {
        figures.push(
          // corner handles (TL, TR, BL, BR) — idx 1-4
          { type: 'circle', attrs: { x: x1, y: y1, r: 4 }, styles: HANDLE_STYLE },
          { type: 'circle', attrs: { x: x2, y: y1, r: 4 }, styles: HANDLE_STYLE },
          { type: 'circle', attrs: { x: x1, y: y2, r: 4 }, styles: HANDLE_STYLE },
          { type: 'circle', attrs: { x: x2, y: y2, r: 4 }, styles: HANDLE_STYLE },
          // edge mid-points (T, B, L, R) — idx 5-8
          { type: 'circle', attrs: { x: cx, y: y1, r: 4 }, styles: HANDLE_STYLE },
          { type: 'circle', attrs: { x: cx, y: y2, r: 4 }, styles: HANDLE_STYLE },
          { type: 'circle', attrs: { x: x1, y: cy, r: 4 }, styles: HANDLE_STYLE },
          { type: 'circle', attrs: { x: x2, y: cy, r: 4 }, styles: HANDLE_STYLE },
        );
      }
      return figures;
    },
    performEventMoveForDrawing: applySnap,
    // performEventPressedMove doesn't fire for custom circle figures, only for
    // needDefaultPointFigure handles. We implement our own drag via capture-
    // phase mouse listeners (see initRectHandleDrag).
    performEventPressedMove: (event) => { setGlobalCursor('grabbing'); applySnap(event); },
    ...overlayInteractions,
  });

  // ----- Measure (date & price range) ----------------------------------
  // TradingView-style tool: draws a translucent rectangle between two points
  // with vertical + horizontal arrows showing the direction of movement, and
  // a stats label (price change, %, tick count, bar count, time span, volume).
  //
  // Values are SIGNED — if you drag from right→left the bar count is negative,
  // if you drag downward the price change is negative. Arrows and label
  // position flip to match the drag direction.
  klinecharts.registerOverlay({
    name: 'measure_snap',
    totalStep: 3,
    // KLineChart renders default draggable point figures at each stored point
    // for us — no need for custom circle handles (and we get drag-to-resize free).
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    styles: {
      crosshair: { color: '#2962ff', size: 1.5 },                    // inner + arrows
      rect:      { color: 'rgba(41,98,255,0.12)',                    // background fill
                   borderColor: '#2962ff', borderSize: 1 },           // only drawn if extendData.borderEnabled
      label:     { bg: 'rgba(30,34,45,0.92)', text: '#d1d4dc', fontSize: 13 },
      point:     { color: '#2962ff', borderColor: '#fff', borderSize: 1, radius: 4 },
    },
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length < 2) return [];
      const [p1, p2] = coordinates;
      const rawDx = p2.x - p1.x;         // + if dragged rightward
      const rawDy = p2.y - p1.y;         // + if dragged downward on screen
      const x1 = Math.min(p1.x, p2.x);
      const x2 = Math.max(p1.x, p2.x);
      const y1 = Math.min(p1.y, p2.y);
      const y2 = Math.max(p1.y, p2.y);
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;

      const sty = overlay.styles || {};
      const rectSty  = sty.rect      || {};
      let csCol  = (sty.crosshair && sty.crosshair.color) || '#2962ff';
      const csSz   = (sty.crosshair && sty.crosshair.size)  || 1.5;

      // Border is opt-in — reuses the existing rect.style='stroke_fill' vs 'fill'.
      // Flag lives on extendData so it's easy to toggle from the settings panel.
      const borderOn = !!(overlay.extendData && overlay.extendData.borderEnabled);
      const rectStyleOverride = {
        ...rectSty,
        style: borderOn ? 'stroke_fill' : 'fill',
      };

      // Shift-gesture measure (Shift+click or Shift+drag from chart) carries
      // `extendData.shiftMeasure === true`. Color the box + arrows by drag
      // direction so the user gets an at-a-glance bull/bear cue:
      //   p2 above p1 (rawDy < 0, higher price) → blue   (matches default)
      //   p2 below p1 (rawDy > 0, lower price)  → red    (#ef5350, KLineChart bear)
      // Regular measures (Alt+M / toolbar) lack the flag → blue always.
      // captureInheritedStyle ignores this flag (only `extendData.text` is
      // captured), so the next regular measure won't inherit red coloring.
      const isShiftMeasure = !!(overlay.extendData && overlay.extendData.shiftMeasure);
      if (isShiftMeasure) {
        const isDown = rawDy > 0;
        if (isDown) {
          csCol = '#ef5350';
          rectStyleOverride.color       = 'rgba(239, 83, 80, 0.12)';
          rectStyleOverride.borderColor = '#ef5350';
        } else {
          rectStyleOverride.color       = 'rgba(41, 98, 255, 0.12)';
          rectStyleOverride.borderColor = '#2962ff';
          // csCol already defaults to #2962ff.
        }
      }

      const figures = [
        { type: 'rect',
          attrs: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
          styles: rectStyleOverride },
      ];

      // Center text (set via settings panel 文字 tab). When non-empty, the
      // horizontal crosshair line is broken with a gap around the text so the
      // stroke doesn't cut through the glyphs.
      const textState = (overlay.extendData && overlay.extendData.text) || null;
      const hasText = !!(textState && textState.content);
      const hGapHalf = hasText ? _measureHorizLineGapHalf(textState) : 0;

      // Horizontal arrow (along cy). Head points in the drag-x direction.
      const hHeadRight = rawDx >= 0;
      const hStart = hHeadRight ? x1 : x2;
      const hEnd   = hHeadRight ? x2 : x1;
      const lineCommon = { color: csCol, size: csSz, style: 'solid' };
      if (hasText && hGapHalf > 0 && (x2 - x1) > hGapHalf * 2) {
        // Two segments with a gap around the text at the center.
        const gapL = cx - hGapHalf;
        const gapR = cx + hGapHalf;
        figures.push({
          type: 'line',
          attrs: { coordinates: [{ x: hStart, y: cy }, { x: hHeadRight ? gapL : gapR, y: cy }] },
          styles: lineCommon,
        });
        figures.push({
          type: 'line',
          attrs: { coordinates: [{ x: hHeadRight ? gapR : gapL, y: cy }, { x: hEnd, y: cy }] },
          styles: lineCommon,
        });
      } else {
        figures.push({
          type: 'line',
          attrs: { coordinates: [{ x: hStart, y: cy }, { x: hEnd, y: cy }] },
          styles: lineCommon,
        });
      }
      figures.push({
        type: 'polygon',
        attrs: { coordinates: _measureArrowHead(hEnd, cy, hHeadRight ? 'right' : 'left', 8) },
        styles: { style: 'fill', color: csCol },
      });

      // Vertical arrow (along cx). Head points in the drag-y direction.
      // Like the horizontal line, the stroke is cut around the text height so
      // the glyphs read cleanly.
      const vHeadUp = rawDy <= 0;
      const vStart = vHeadUp ? y2 : y1;
      const vEnd   = vHeadUp ? y1 : y2;
      const vGapHalf = hasText ? _measureVertLineGapHalf(textState) : 0;
      if (hasText && vGapHalf > 0 && (y2 - y1) > vGapHalf * 2) {
        // Screen-coord y: smaller value is visually higher.
        const gapTop = cy - vGapHalf;
        const gapBot = cy + vGapHalf;
        const nearCy = vHeadUp ? gapBot : gapTop;  // endpoint closer to start
        const farCy  = vHeadUp ? gapTop : gapBot;  // endpoint closer to end
        figures.push({
          type: 'line',
          attrs: { coordinates: [{ x: cx, y: vStart }, { x: cx, y: nearCy }] },
          styles: lineCommon,
        });
        figures.push({
          type: 'line',
          attrs: { coordinates: [{ x: cx, y: farCy }, { x: cx, y: vEnd }] },
          styles: lineCommon,
        });
      } else {
        figures.push({
          type: 'line',
          attrs: { coordinates: [{ x: cx, y: vStart }, { x: cx, y: vEnd }] },
          styles: lineCommon,
        });
      }
      figures.push({
        type: 'polygon',
        attrs: { coordinates: _measureArrowHead(cx, vEnd, vHeadUp ? 'up' : 'down', 8) },
        styles: { style: 'fill', color: csCol },
      });

      // Center text — drawn on the horizontal midline between the two line
      // segments. No +新增文字 placeholder (unlike rect / trendline) — user
      // MUST enter text via the settings panel 文字 tab.
      if (hasText) {
        figures.push(..._measureCenterTextFigures(cx, cy, textState, csCol));
      }

      // Stats label — position follows the vertical drag direction.
      const lines = _buildMeasureLabel(overlay);
      const labelAbove = vHeadUp;
      const anchorY = labelAbove ? y1 - 6 : y2 + 6;
      figures.push(..._measureLabelFigures(cx, anchorY, labelAbove ? 'above' : 'below', lines, sty.label));

      return figures;
    },
    performEventMoveForDrawing: applySnap,
    performEventPressedMove: (event) => { setGlobalCursor('grabbing'); applySnap(event); },
    ...overlayInteractions,
  });

  // ----- Path (multi-point polyline). User finishes via right-click / dbl-click / Esc -----
  // KLineChart has no native 'polyline' figure — render N-1 line segments.
  // Two templates needed:
  //   path_snap  totalStep:999  for the drawing phase (accepts unlimited clicks)
  //   path_done  totalStep:1    for finalized paths (static, never enters draw mode)
  const pathFigures = ({ coordinates, overlay }) => {
    if (coordinates.length < 2) return [];
    const lineStyle = (overlay.styles && overlay.styles.line) || {};
    const figs = [];
    for (let i = 0; i < coordinates.length - 1; i++) {
      figs.push({
        type: 'line',
        attrs: { coordinates: [coordinates[i], coordinates[i + 1]] },
        styles: lineStyle,
      });
    }
    return figs;
  };

  const pathDefaultStyles = {
    line: { color: '#2962ff', size: 1, style: 'solid' },
    point: { color: '#2962ff', borderColor: '#fff', borderSize: 1, radius: 4 },
  };

  klinecharts.registerOverlay({
    name: 'path_snap',
    totalStep: 999,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    styles: pathDefaultStyles,
    createPointFigures: pathFigures,
    performEventMoveForDrawing: applySnap,
    performEventPressedMove: applySnap,
    onRightClick: () => true,
    // Block KLineChart's default double-click (may finalize/cancel drawing) —
    // we handle dblclick ourselves at the chart element with a position check.
    onDoubleClick: () => true,
  });

  klinecharts.registerOverlay({
    name: 'path_done',
    totalStep: 1,                  // 1 = no drawing steps, immediately finished
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    styles: pathDefaultStyles,
    createPointFigures: pathFigures,
    performEventPressedMove: (event) => { setGlobalCursor('grabbing'); applySnap(event); },
    ...overlayInteractions,
  });

  // ----- Fibonacci tools ----------------------------------------------
  // Two overlays: retracement (2 points = high + low) and trend-based
  // extension (3 points = trend start + trend end + projection anchor).
  // Both consume the same per-overlay `extendData = { fibo: {...},
  // levels: [...] }` schema; see module-level FIBO_LEVEL_DEFAULTS and
  // FIBO_CONFIG_DEFAULTS for the seed values.
  //
  // Render contract (buildFiboFigures):
  //   - kind === 'retrace':  anchors at points[0] (0 level) and points[1] (1 level).
  //                          Lines span min(p1.x, p2.x) → max(p1.x, p2.x).
  //   - kind === 'extension':
  //       - 2 points → preliminary render identical to retrace (so users
  //                    see the fibo shape before placing the third point)
  //       - 3 points → 0 level anchored at p3, 1 level at p3 + (p2-p1).
  //                    Lines span p3.x → chart right edge.
  //                    Trend connectors (p1→p2, p2→p3) drawn dashed.
  function _fiboMaxX(bounding) {
    if (!bounding) return null;
    return bounding.x + bounding.width;
  }
  function _drawFiboLevels(figures, opts) {
    const { a0Y, a1Y, a0Price, a1Price, xLeft, xRight, fibo, levels } = opts;
    const enabled = levels.filter(L => L.on);
    if (!enabled.length) return;
    const dy = a1Y - a0Y;
    const dPrice = a1Price - a0Price;
    // Sort by ratio so background banding fills consecutive bands.
    const sorted = enabled.slice().sort((a, b) => a.r - b.r);
    // Background fill — alternating bands between consecutive levels.
    if (fibo.showBackground && sorted.length >= 2) {
      for (let i = 0; i < sorted.length - 1; i++) {
        const L = sorted[i];
        const Lnext = sorted[i + 1];
        const y0 = a0Y + L.r * dy;
        const y1 = a0Y + Lnext.r * dy;
        const color = fibo.singleColor || L.color;
        figures.push({
          type: 'rect',
          attrs: {
            x: xLeft,
            y: Math.min(y0, y1),
            width: xRight - xLeft,
            height: Math.abs(y1 - y0),
          },
          styles: { style: 'fill', color: _hexToRgba(color, fibo.backgroundAlpha) },
        });
      }
    }
    // Horizontal lines + price labels.
    // Label positioning matches TradingView: text lives OUTSIDE the box on
    // its LEFT side (just past xLeft), right-aligned so it grows leftward
    // from the band's left edge. No background — the text color alone
    // identifies which level it belongs to. baseline:'middle' centers the
    // text vertically on the line.
    for (const L of enabled) {
      const y = a0Y + L.r * dy;
      const price = a0Price + L.r * dPrice;
      const color = fibo.singleColor || L.color;
      figures.push({
        type: 'line',
        attrs: { coordinates: [{ x: xLeft, y }, { x: xRight, y }] },
        styles: { color, size: 1, style: fibo.hLineStyle || 'solid' },
      });
      figures.push({
        type: 'text',
        attrs: {
          x: xLeft - 6,                 // 6 px gap from band's left edge
          y,
          text: `${L.r} (${price.toFixed(2)})`,
          align: 'right',               // text right edge sits at x → grows leftward
          baseline: 'middle',           // vertically centered on the line
        },
        // backgroundColor/borderColor/padding zeroed out so KLineChart
        // doesn't inherit the overlay's blue point colour as a tag box
        // around the text. We want ONLY the glyph painted in the level
        // colour — no chip, no border, no padding (TradingView look).
        styles: {
          color,
          size: 12,
          family: 'system-ui,-apple-system,sans-serif',
          backgroundColor: 'transparent',
          borderColor:     'transparent',
          borderSize:      0,
          paddingLeft:  0, paddingRight:  0,
          paddingTop:   0, paddingBottom: 0,
        },
      });
    }
  }
  function buildFiboFigures({ overlay, coordinates, bounding, kind }) {
    if (coordinates.length < 1) return [];
    const config = _fiboConfigOf(overlay);
    const fibo = config.fibo || FIBO_CONFIG_DEFAULTS;
    const levels = config.levels || FIBO_LEVEL_DEFAULTS;
    const points = overlay.points || [];
    const figures = [];
    const isDrawing  = Drawing.drawingId === overlay.id;
    const isSelected = Drawing.selectedOverlay && Drawing.selectedOverlay.id === overlay.id;

    // For the trend-based fibonacci extension the user clicks 3 points:
    //   #1 start of move, #2 end of move, #3 end of retracement.
    // Per TradingView's spec the fibonacci levels only appear AFTER all 3
    // points are placed — before that we just show the trend connector
    // line(s) so the user can see what they've drawn so far.
    // (Web source: tradingview.com/.../trend-based-fib-extension)
    if (kind === 'extension' && coordinates.length < 3) {
      if (coordinates.length >= 2 && fibo.trendLineColor) {
        figures.push({
          type: 'line',
          attrs: { coordinates: [coordinates[0], coordinates[1]] },
          styles: {
            color: fibo.trendLineColor,
            size: 1,
            style: fibo.trendLineStyle || 'dashed',
          },
        });
      }
      // Default-point figures render the anchor circles for us (KLineChart
      // auto-renders one per stored point when the overlay is being drawn).
      return figures;
    }

    // From here either retracement with 2 points, or extension with 3.
    if (coordinates.length < 2) return figures;

    let a0Y, a1Y, a0Price, a1Price, xLeft, xRight;

    if (kind === 'extension') {
      // 3-point extension. Trend = #1 → #2 ; project from #3.
      //   0 level  = #3 (retracement endpoint)
      //   1 level  = #3 + (#2 - #1)  (one full magnitude of the original move)
      //   1.618    = #3 + 1.618 × (#2 - #1)  …etc.
      const [p1, p2, p3] = coordinates;
      const trendDyScreen = p2.y - p1.y;
      const trendDyPrice  = (points[1] && points[0])
        ? (points[1].value - points[0].value) : 0;
      a0Y = p3.y;
      a1Y = p3.y + trendDyScreen;
      a0Price = (points[2] && points[2].value) || 0;
      a1Price = a0Price + trendDyPrice;
      if (fibo.reverse) {
        // Reverse flips the projection direction so the "1" level lands
        // on the opposite side of p3 (mirroring through #3).
        a1Y = 2 * a0Y - a1Y;
        a1Price = 2 * a0Price - a1Price;
      }
      // Box X-range covers from p2 to p3 (the retracement segment), matching
      // the user-requested visual of "從第二個點畫到第三個點". The vertical
      // fib levels (0 at p3, 1 at p3+(p2−p1), 1.618 etc.) still render within
      // this horizontal extent so user can see the projection against the
      // retracement region. extend=right/both pushes the right edge to chart
      // edge to also visualize future price action against the projected levels.
      const x23min = Math.min(p2.x, p3.x);
      const x23max = Math.max(p2.x, p3.x);
      const xMax = _fiboMaxX(bounding) || x23max;
      xLeft  = (fibo.extend === 'left'  || fibo.extend === 'both') ? 0    : x23min;
      xRight = (fibo.extend === 'right' || fibo.extend === 'both') ? xMax : x23max;
      // Trend connector — dashed grey by default — runs #1 → #2 → #3 to
      // show the construction the projection is based on.
      if (fibo.trendLineColor) {
        figures.push({
          type: 'line',
          attrs: { coordinates: [coordinates[0], coordinates[1]] },
          styles: { color: fibo.trendLineColor, size: 1, style: fibo.trendLineStyle || 'dashed' },
        });
        figures.push({
          type: 'line',
          attrs: { coordinates: [coordinates[1], coordinates[2]] },
          styles: { color: fibo.trendLineColor, size: 1, style: fibo.trendLineStyle || 'dashed' },
        });
      }
    } else {
      // 2-point retracement. TradingView labels the FIRST click as the "1"
      // level (start of the measured move) and the SECOND click as "0"
      // (where the move ended) — drag from high to low for a downtrend
      // retracement, low to high for an uptrend, etc. The user's earlier
      // screenshot confirmed this orientation ("1" at the move's start,
      // "0" at the most recent extreme).
      const [p1, p2] = coordinates;
      a1Y = p1.y;                            // "1" lives at click #1
      a0Y = p2.y;                            // "0" lives at click #2
      a1Price = (points[0] && points[0].value) || 0;
      a0Price = (points[1] && points[1].value) || 0;
      if (fibo.reverse) {
        const tmp = a0Y; a0Y = a1Y; a1Y = tmp;
        const tmpP = a0Price; a0Price = a1Price; a1Price = tmpP;
      }
      const x1 = Math.min(p1.x, p2.x);
      const x2 = Math.max(p1.x, p2.x);
      const xMax = _fiboMaxX(bounding) || x2;
      xLeft  = (fibo.extend === 'left'  || fibo.extend === 'both') ? 0    : x1;
      xRight = (fibo.extend === 'right' || fibo.extend === 'both') ? xMax : x2;
      // Trend connector for retracement — dashed line from p1 to p2, same
      // style as extension. Tells the user where the measured move runs.
      // (Matches TradingView's retracement preview behavior.)
      if (fibo.trendLineColor) {
        figures.push({
          type: 'line',
          attrs: { coordinates: [p1, p2] },
          styles: { color: fibo.trendLineColor, size: 1, style: fibo.trendLineStyle || 'dashed' },
        });
      }
    }

    _drawFiboLevels(figures, { a0Y, a1Y, a0Price, a1Price, xLeft, xRight, fibo, levels });
    // KLineChart's default point figures render circle handles at every anchor
    // when the overlay is selected/drawing (because needDefaultPointFigure is
    // true on both fibo templates). The default handles also drive native drag
    // via performEventPressedMove, so anchors are resizable just like the
    // built-in trendline / segment tools. No manual circles needed here.
    return figures;
  }

  // Trend-Based Fib TIME — the time-axis analogue of the trend-based fib
  // extension. 3 points: #1→#2 define a reference TIME interval (a wave's
  // duration), #3 is the projection origin. We draw VERTICAL lines at fib
  // ratios of that interval projected forward in time (X axis), so the user
  // reads "time 1:1 / 1.618 …" the way the price extension reads price ratios.
  // Projection is done in PIXEL space (bar spacing is uniform) so it re-derives
  // correctly on every scroll/zoom. Reuses the fibo config (levels/colors/
  // background/reverse) so FiboSettings edits it too.
  // Real pane pixel height for the full-height vertical lines. KLineChart's
  // `bounding` here is normally the candle-pane bounding, but some render paths
  // pass the overlay's own (tiny) bbox instead — trust it only when it looks
  // pane-sized, else read the chart element. Using a real height (not a huge
  // constant) keeps KLineChart's re-render after overrideOverlay happy — an
  // absurd coordinate made the whole overlay vanish on a colour/background edit.
  function _fiboTimePaneHeight(bounding) {
    const h = bounding && bounding.height;
    if (Number.isFinite(h) && h > 60) return h;
    try { const el = document.getElementById('chart'); if (el && el.clientHeight > 0) return el.clientHeight; } catch (e) {}
    return 800;
  }
  function buildFiboTimeFigures({ overlay, coordinates, bounding }) {
    if (!coordinates || coordinates.length < 1) return [];
    const config = _fiboConfigOf(overlay);
    const fibo   = config.fibo || FIBO_CONFIG_DEFAULTS;
    const levels = config.levels || FIBO_LEVEL_DEFAULTS;
    const figures = [];

    // Before all 3 points: just show the connector so the reference leg shows.
    if (coordinates.length < 3) {
      if (coordinates.length >= 2 && fibo.trendLineColor) {
        figures.push({ type: 'line', attrs: { coordinates: [coordinates[0], coordinates[1]] },
          styles: { color: fibo.trendLineColor, size: 1, style: fibo.trendLineStyle || 'dashed' } });
      }
      return figures;
    }

    const [p1, p2, p3] = coordinates;
    const dxUnit = p2.x - p1.x;                  // one "1.0" time unit, in pixels
    const sign = fibo.reverse ? -1 : 1;
    // Full-height vertical lines, using the real pane pixel height (y=0 is the
    // pane top in this coordinate space).
    const top = 0;
    const bot = _fiboTimePaneHeight(bounding);
    const labelY = 2;                            // label pinned near the pane top
    const xAt = (r) => p3.x + sign * r * dxUnit;

    // Construction connectors #1→#2→#3 (dashed).
    if (fibo.trendLineColor) {
      figures.push({ type: 'line', attrs: { coordinates: [p1, p2] },
        styles: { color: fibo.trendLineColor, size: 1, style: fibo.trendLineStyle || 'dashed' } });
      figures.push({ type: 'line', attrs: { coordinates: [p2, p3] },
        styles: { color: fibo.trendLineColor, size: 1, style: fibo.trendLineStyle || 'dashed' } });
    }

    const enabled = levels.filter(L => L.on);
    if (!enabled.length) return figures;
    const sorted = enabled.slice().sort((a, b) => a.r - b.r);

    // Background bands between consecutive vertical lines.
    if (fibo.showBackground && sorted.length >= 2) {
      for (let i = 0; i < sorted.length - 1; i++) {
        const x0 = xAt(sorted[i].r), x1 = xAt(sorted[i + 1].r);
        const color = fibo.singleColor || sorted[i].color;
        figures.push({ type: 'rect',
          attrs: { x: Math.min(x0, x1), y: top, width: Math.abs(x1 - x0), height: bot - top },
          styles: { style: 'fill', color: _hexToRgba(color, fibo.backgroundAlpha) } });
      }
    }

    // Vertical lines + ratio labels (label sits at the top of each line).
    for (const L of enabled) {
      const x = xAt(L.r);
      const color = fibo.singleColor || L.color;
      figures.push({ type: 'line', attrs: { coordinates: [{ x, y: top }, { x, y: bot }] },
        styles: { color, size: 1, style: fibo.hLineStyle || 'solid' } });
      // Label sits BESIDE the line (a few px to its right), not centered on it —
      // matches TradingView, where the vertical line doesn't cut through the text.
      figures.push({ type: 'text',
        attrs: { x: x + 4, y: labelY, text: `${L.r}`, align: 'left', baseline: 'top' },
        styles: { color, size: 12, family: 'system-ui,-apple-system,sans-serif',
          backgroundColor: 'transparent', borderColor: 'transparent', borderSize: 0,
          paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 } });
    }
    return figures;
  }

  klinecharts.registerOverlay({
    name: 'fibo_retrace',
    totalStep: 3,                   // 2 clicks + finalize
    // needDefaultPointFigure:true → KLineChart renders the anchor circles
    // and drives native handle drag (performEventPressedMove fires for
    // each default-point figure), so the user can resize the fibo by
    // dragging either endpoint, just like a trendline.
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    styles: { point: { color: '#2962ff', borderColor: '#fff', borderSize: 1, radius: 4 } },
    createPointFigures: ({ coordinates, overlay, bounding }) =>
      buildFiboFigures({ overlay, coordinates, bounding, kind: 'retrace' }),
    performEventMoveForDrawing: applySnap,
    performEventPressedMove: (event) => { setGlobalCursor('grabbing'); applySnap(event); },
    ...overlayInteractions,
  });

  klinecharts.registerOverlay({
    name: 'fibo_extension',
    totalStep: 4,                   // 3 clicks + finalize
    // Same rationale as fibo_retrace — let KLineChart handle the 3 anchor
    // handles + native drag.
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    styles: { point: { color: '#2962ff', borderColor: '#fff', borderSize: 1, radius: 4 } },
    createPointFigures: ({ coordinates, overlay, bounding }) =>
      buildFiboFigures({ overlay, coordinates, bounding, kind: 'extension' }),
    performEventMoveForDrawing: applySnap,
    performEventPressedMove: (event) => { setGlobalCursor('grabbing'); applySnap(event); },
    ...overlayInteractions,
  });

  klinecharts.registerOverlay({
    name: 'fibo_time',
    totalStep: 4,                   // 3 clicks + finalize (like fibo_extension)
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    styles: { point: { color: '#2962ff', borderColor: '#fff', borderSize: 1, radius: 4 } },
    createPointFigures: ({ coordinates, overlay, bounding }) =>
      buildFiboTimeFigures({ overlay, coordinates, bounding }),
    performEventMoveForDrawing: applySnap,
    performEventPressedMove: (event) => { setGlobalCursor('grabbing'); applySnap(event); },
    ...overlayInteractions,
  });

  // ----- Long / short position (entry / target / stop) ----------------
  // Single click drops the position with default 1:1 R:R (target & stop
  // equidistant from entry). Auto-fill happens in setTool's onDrawEnd hook.
  // KLineChart's default point figures give us 3 draggable handles after
  // the auto-fill commits. All sizing params live on overlay.extendData.position.
  klinecharts.registerOverlay({
    name: 'long_position',
    totalStep: 2,                  // 1 click — target & stop are auto-filled
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    styles: {
      point: { color: '#2962ff', borderColor: '#fff', borderSize: 1, radius: 4 },
    },
    createPointFigures: ({ coordinates, overlay }) =>
      _buildPositionFigures(coordinates, overlay, 'long'),
    performEventMoveForDrawing: applySnap,
    performEventPressedMove: (event) => {
      setGlobalCursor('grabbing');
      applySnap(event);
      _enforcePositionConstraints(event, 'long');
    },
    ...overlayInteractions,
  });

  klinecharts.registerOverlay({
    name: 'short_position',
    totalStep: 2,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    styles: {
      point: { color: '#2962ff', borderColor: '#fff', borderSize: 1, radius: 4 },
    },
    createPointFigures: ({ coordinates, overlay }) =>
      _buildPositionFigures(coordinates, overlay, 'short'),
    performEventMoveForDrawing: applySnap,
    performEventPressedMove: (event) => {
      setGlobalCursor('grabbing');
      applySnap(event);
      _enforcePositionConstraints(event, 'short');
    },
    ...overlayInteractions,
  });
}

// ===== Snap callback shared by all custom overlays =====
function applySnap(event) {
  if (!event || !event.performPoint) return;
  const ss = window.SnapState;
  const bars = window.App && window.App.currentBars;

  // OHLC snap (Ctrl held)
  if (ss.ctrlHeld && bars && bars.length) {
    const idx = event.performPoint.dataIndex;
    const bar = bars[idx];
    if (bar) {
      event.performPoint.value = snapToOHLC(bar, event.performPoint.value);
    }
  }

  // Axis lock (Shift held) — relative to the previous committed point
  if (ss.shiftHeld && event.points && event.points.length >= 2) {
    const ref = event.points[event.performPointIndex - 1] || event.points[0];
    if (ref) {
      const dx = Math.abs(event.performPoint.dataIndex - ref.dataIndex);
      const refSpan = Math.max(Math.abs(ref.value) * 0.0005, 0.5);
      const dy = Math.abs(event.performPoint.value - ref.value) / refSpan;
      if (dy < dx) {
        // closer to horizontal → snap y
        event.performPoint.value = ref.value;
      } else {
        // closer to vertical → snap x
        event.performPoint.dataIndex = ref.dataIndex;
        event.performPoint.timestamp = ref.timestamp;
      }
    }
  }
}

// ===== Finalize an in-progress path overlay =====
// Uses Drawing.drawingId / Drawing.drawingPoints captured via onDrawing callback.
// KLineChart appends a "preview point" at the cursor for the not-yet-committed
// next click. On right-click finalize, drop that trailing preview so the saved
// path matches the user's actual left-clicks only.
function finalizeInProgressPath() {
  // Which chart the in-progress path lives on — set per point in
  // _handleDrawMousedown (null → main). Lets right-click / dblclick / Esc
  // finalize a path drawn on the mini onto the mini, not the main chart.
  const host = Drawing._pathHost || 'main';
  const isMini = host === 'mini';
  const chart = isMini ? (window.MiniChart && window.MiniChart.chart) : Drawing.chart;
  const id = isMini ? Drawing._miniDrawId : Drawing.drawingId;
  if (!chart || !id) return;
  let pts = (Drawing.drawingPoints || []).filter(p => p && Number.isFinite(p.value));

  // Drop trailing preview point (the one tracking the cursor that's about to become
  // the next click position — but we're cancelling instead via right-click).
  // Exception: in 繼續連接 mode, if the user hasn't moved the cursor or clicked yet,
  // drawingPoints equals the original point count — nothing to drop.
  const hasPreview = !(_continuePathInitialLen > 0 && pts.length === _continuePathInitialLen);
  if (hasPreview && pts.length > 0) pts = pts.slice(0, -1);

  // Always remove the in-progress overlay from KLineChart (resets its drawing state)
  try { chart.removeOverlay({ id }); } catch (e) { /* ignore */ }
  if (isMini) Drawing._miniDrawId = null; else Drawing.drawingId = null;
  Drawing.drawingPoints = [];

  // Re-create as a completed static overlay (path_done has totalStep:1 → never re-enters draw mode)
  untrackOverlay(id);
  if (pts.length >= 2) {
    const opts = { name: 'path_done', points: pts };
    // If we're finalizing a "繼續連接" session, keep the original path's
    // styles; otherwise use the inheritance bucket.
    if (_continuePathStyles || _continuePathExtendData) {
      if (_continuePathStyles)     opts.styles     = _continuePathStyles;
      if (_continuePathExtendData) opts.extendData = _continuePathExtendData;
    } else {
      const inherit = getInheritedStyle('path_done');
      if (inherit) {
        if (inherit.styles)     opts.styles     = inherit.styles;
        if (inherit.extendData) opts.extendData = inherit.extendData;
      }
    }
    const newId = chart.createOverlay(opts);
    if (typeof newId === 'string') {
      // Route trackOverlay to the right registry (main vs _miniRegistry).
      if (isMini) Drawing._drawHost = 'mini';
      trackOverlay({ id: newId, name: 'path_done', points: pts, styles: opts.styles, extendData: opts.extendData });
      if (isMini) Drawing._drawHost = 'main';
    }
  }
  _continuePathStyles = null;
  _continuePathExtendData = null;
  _continuePathInitialLen = 0;
  Drawing._pathHost = null;
  // Drop the OTHER chart's still-armed in-progress path (setTool arms both).
  _cancelDrawOnOtherChart(host);
  refreshObjectTree();
}

// Path-continue state: when the user picks "繼續連接" on a completed path,
// the original's styles/extendData/points are stashed here so finalize can
// re-create the path_done with the same look. Cleared on finalize/cancel.
let _continuePathStyles = null;
let _continuePathExtendData = null;
// Point count at continue start — used to detect "user hasn't added anything
// yet" so we don't accidentally drop one of the original points as if it
// were a trailing cursor-preview point.
let _continuePathInitialLen = 0;

// Cancel any in-progress overlay (trendline/rectangle/path) without keeping it
function cancelInProgressDraw() {
  if (!Drawing.chart || !Drawing.drawingId) return;
  try { Drawing.chart.removeOverlay({ id: Drawing.drawingId }); } catch (e) { /* ignore */ }
  Drawing.drawingId = null;
  Drawing.drawingPoints = [];
  _continuePathStyles = null;
  _continuePathExtendData = null;
  _continuePathInitialLen = 0;
}

// Re-enter path drawing mode from the last point of a completed path_done.
// Invoked from the right-click context menu ("繼續連接") — a feature TradingView
// doesn't have.
function continueSelectedPath() {
  const ov = Drawing.selectedOverlay;
  if (!ov || ov.name !== 'path_done') return;
  const entry = Drawing.overlayRegistry.get(ov.id) || ov;
  if (entry.lock) return;
  if (!entry.points || entry.points.length < 2) return;

  // Snapshot the original so finalize can rebuild the path_done with the same
  // style (even if the inheritance bucket has moved on).
  const points     = entry.points.map(p => ({ ...p }));
  const styles     = entry.styles     ? JSON.parse(JSON.stringify(entry.styles))     : null;
  const extendData = entry.extendData ? JSON.parse(JSON.stringify(entry.extendData)) : null;

  _continuePathStyles     = styles;
  _continuePathExtendData = extendData;
  _continuePathInitialLen = points.length;

  // Remove the original path_done; we'll recreate on finalize.
  try { Drawing.chart.removeOverlay({ id: ov.id }); } catch (e) { /* ignore */ }
  untrackOverlay(ov.id);
  Drawing.selectedOverlay = null;
  hideContextMenu();

  // Activate path tool UI without re-calling setTool (which would wipe points).
  Drawing.activeTool = 'path';
  if (Drawing._updateSnapIndicator) Drawing._updateSnapIndicator();
  document.querySelectorAll('#leftbar .tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === 'path');
  });
  document.querySelectorAll('#tool-quickbar .quick-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === 'path');
  });
  const quickbar = document.getElementById('tool-quickbar');
  if (quickbar) quickbar.classList.remove('hidden');
  try { Drawing.chart.setScrollEnabled(false); } catch (e) { /* ignore */ }
  try { Drawing.chart.setZoomEnabled(false); } catch (e) { /* ignore */ }

  Drawing.drawingId = null;
  Drawing.drawingPoints = points.slice();

  const opts = {
    name: 'path_snap',
    points,
    onDrawStart: (event) => {
      const o = event && (event.overlay || event);
      if (o && o.id) Drawing.drawingId = o.id;
      if (o && o.points) Drawing.drawingPoints = o.points.slice();
    },
    onDrawing: (event) => {
      const o = event && (event.overlay || event);
      if (o && o.id) Drawing.drawingId = o.id;
      if (o && o.points) Drawing.drawingPoints = o.points.slice();
    },
    onDrawEnd: (event) => {
      const o = event && (event.overlay || event);
      if (o && o.id) trackOverlay(o);
      Drawing.drawingId = null;
      Drawing.drawingPoints = [];
      _continuePathStyles = null;
      _continuePathExtendData = null;
      _continuePathInitialLen = 0;
      setTimeout(() => {
        setTool('cross');
        refreshObjectTree();
      }, 50);
    },
  };
  if (styles)     opts.styles     = styles;
  if (extendData) opts.extendData = extendData;

  try {
    Drawing.chart.createOverlay(opts);
  } catch (err) {
    // If KLineChart rejects, restore the original so the user doesn't lose it.
    console.warn('[continueSelectedPath] createOverlay failed', err);
    const restoreOpts = { name: 'path_done', points };
    if (styles)     restoreOpts.styles     = styles;
    if (extendData) restoreOpts.extendData = extendData;
    try {
      const newId = Drawing.chart.createOverlay(restoreOpts);
      if (typeof newId === 'string') {
        trackOverlay({ id: newId, name: 'path_done', points, styles, extendData });
      }
    } catch (e2) {}
    _continuePathStyles = null;
    _continuePathExtendData = null;
    setTool('cross');
  }
}

// ===== Tool activation =====
// Finalize a Shift+drag measure gesture: remove the in-progress overlay
// (which only has point A seeded) and recreate as a complete measure with
// both points. KLineChart treats a fresh `createOverlay({ name, points:
// [A, B] })` on a totalStep:3 overlay as immediately complete — same trick
// the path/trendline/rectangle click-takeover uses (PROGRESS §4a).
function _finalizeShiftMeasureDrag(pointA, pointB) {
  if (!Drawing.chart) return;
  const drawingId = Drawing.drawingId;
  // Preserve any inherited styles/extendData from the in-progress overlay
  // so the released measure looks like the user's saved style template.
  let ovStyles, ovExtendData;
  if (drawingId) {
    try {
      const arr = Drawing.chart.getOverlays ? Drawing.chart.getOverlays() : [];
      const match = arr.find(o => o && o.id === drawingId);
      if (match) { ovStyles = match.styles; ovExtendData = match.extendData; }
    } catch (e) { /* ignore */ }
  }
  if (!ovStyles || !ovExtendData) {
    const inh = getInheritedStyle('measure_snap');
    if (!ovStyles     && inh && inh.styles)     ovStyles     = inh.styles;
    if (!ovExtendData && inh && inh.extendData) ovExtendData = inh.extendData;
  }
  // Tear down the seeded overlay so KLineChart's drawing state-machine
  // doesn't keep waiting for click #2 after we recreate.
  if (drawingId) {
    try { Drawing.chart.removeOverlay({ id: drawingId }); } catch (e) {}
    untrackOverlay(drawingId);
  }
  Drawing.drawingId = null;
  Drawing.drawingPoints = [];
  // Always carry the shiftMeasure flag onto the recreated overlay (the
  // in-progress one had it from _startMeasureAtPoint; we re-stamp here so
  // a missing/cleared ovExtendData still ends up flagged).
  const finalExtend = { ...(ovExtendData || {}), shiftMeasure: true };
  const opts = { name: 'measure_snap', points: [pointA, pointB], extendData: finalExtend };
  if (ovStyles) opts.styles = ovStyles;
  let newId;
  try { newId = Drawing.chart.createOverlay(opts); } catch (e) {}
  if (typeof newId === 'string') {
    trackOverlay({
      id: newId,
      name: 'measure_snap',
      points: [pointA, pointB],
      styles: ovStyles,
      extendData: finalExtend,
    });
  }
  setTool('cross');
  if (typeof refreshObjectTree === 'function') {
    try { refreshObjectTree(); } catch (e) {}
  }
}

// Start a measure overlay with the first anchor pre-seeded at a chart point.
// Used by the Shift+Left-click shortcut in initRectHandleDrag — saves the
// user a trip through setTool + first click. KLineChart's measure_snap has
// totalStep:3 (2 clicks + finalize), so seeding `points: [seed]` makes the
// chart wait for the second click while already rendering the stats label.
function _startMeasureAtPoint(seedPoint) {
  if (!Drawing.chart) return;
  // Mirror the toolbar / UI state changes that setTool('measure') would do.
  Drawing.activeTool = 'measure';
  if (Drawing._updateSnapIndicator) Drawing._updateSnapIndicator();
  document.querySelectorAll('#leftbar .tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === 'measure');
  });
  document.querySelectorAll('#tool-quickbar .quick-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === 'measure');
  });
  try { Drawing.chart.setScrollEnabled(false); } catch (e) {}
  try { Drawing.chart.setZoomEnabled(false); } catch (e) {}
  const quickbar = document.getElementById('tool-quickbar');
  if (quickbar) quickbar.classList.remove('hidden');
  Drawing.drawingId = null;
  Drawing.drawingPoints = [];
  const opts = {
    name: 'measure_snap',
    points: [seedPoint],
    onDrawStart: (event) => {
      const ov = event && (event.overlay || event);
      if (ov && ov.id) Drawing.drawingId = ov.id;
      if (ov && ov.points) Drawing.drawingPoints = ov.points.slice();
    },
    onDrawing: (event) => {
      const ov = event && (event.overlay || event);
      if (ov && ov.id) Drawing.drawingId = ov.id;
      if (ov && ov.points) Drawing.drawingPoints = ov.points.slice();
    },
    onDrawEnd: (event) => {
      const ov = event && (event.overlay || event);
      if (ov && ov.id) trackOverlay(ov);
      Drawing.drawingId = null;
      Drawing.drawingPoints = [];
      setTimeout(() => {
        setTool('cross');
        refreshObjectTree();
      }, 50);
    },
  };
  // Inherit style from the last-customized measure overlay (same rule
  // as setTool — text content intentionally NOT inherited).
  const inherit = getInheritedStyle('measure_snap');
  if (inherit) {
    if (inherit.styles) opts.styles = inherit.styles;
    if (inherit.extendData) opts.extendData = inherit.extendData;
  }
  // Tag this overlay as a Shift-gesture measure so the renderer can apply
  // direction-based color (up=blue, down=red). Regular Alt+M / toolbar
  // measures don't carry this flag → default blue across the board.
  // captureInheritedStyle only snapshots `extendData.text` (see line ~5191),
  // so this flag won't leak into subsequently-inherited regular measures.
  opts.extendData = { ...(opts.extendData || {}), shiftMeasure: true };
  Drawing.chart.createOverlay(opts);
}

// Map each grouped tool → its group id. Used by setTool to keep the group
// trigger button's icon + active state in sync (TV-style collapsible groups
// where the trigger shows the last-selected tool from its group). Tools NOT
// in this map (cross, position-settings, clear-all) are standalone leftbar
// buttons handled by the existing .tool-btn[data-tool] selector.
const _TOOL_GROUP_MAP = {
  trendline:       'trend',
  curve:           'trend',
  rectangle:       'trend',
  path:            'trend',
  'fibo-retrace':  'fibonacci',
  'fibo-extension':'fibonacci',
  'fibo-time':     'fibonacci',
  measure:         'forecast',
  'long-position': 'forecast',
  'short-position':'forecast',
};

// Sync the group-trigger button's visual state when a tool is activated:
//   - which SVG inside the trigger is visible (data-icon-for === tool)
//   - whether the trigger gets the .active class (drives blue underline /
//     border styling)
//   - which popup item shows as active (highlighted row inside popup)
// Called from setTool() AFTER the singleton .tool-btn loop so non-grouped
// buttons get their own .active toggle independently.
function _syncToolGroupTrigger(tool) {
  // Clear ALL group triggers' active state first — only one group can have
  // an active tool at a time (or none, if tool is 'cross' / a singleton).
  document.querySelectorAll('.tool-group-trigger').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tool-popup-item').forEach(i => i.classList.remove('active'));
  const group = _TOOL_GROUP_MAP[tool];
  if (!group) return;                                  // not a grouped tool
  const groupEl = document.querySelector(`.tool-group[data-group="${group}"]`);
  if (!groupEl) return;
  // Swap visible icon inside trigger.
  groupEl.querySelectorAll('[data-icon-for]').forEach(svg => {
    svg.classList.toggle('active', svg.dataset.iconFor === tool);
  });
  // Mark trigger active.
  const trigger = groupEl.querySelector('.tool-group-trigger');
  if (trigger) trigger.classList.add('active');
  // Mark matching popup item active for the next time the user opens it.
  const popupItem = document.querySelector(`.tool-popup-item[data-tool="${tool}"]`);
  if (popupItem) popupItem.classList.add('active');
}

// Toggle a specific group's popup. If it's already open, close it; otherwise
// close any other open popup first, then open this one. Outside-click and
// any subsequent setTool() also close popups.
function _toggleToolGroupPopup(group) {
  const popup = document.querySelector(`.tool-group-popup[data-group="${group}"]`);
  if (!popup) return;
  const willOpen = popup.classList.contains('hidden');
  _closeAllToolGroupPopups();
  if (willOpen) popup.classList.remove('hidden');
}
function _closeAllToolGroupPopups() {
  document.querySelectorAll('.tool-group-popup').forEach(p => p.classList.add('hidden'));
}

// Draw target — which chart the active tool draws onto, and which "host"
// (main / mini) the resulting overlay belongs to. A null target means the
// main chart. The mini chart's draw entry sets this so a tool can place its
// overlay on the sub-chart; setTool('cross') resets it back to main.
Drawing._drawTarget = null;
Drawing._drawHost = 'main';
function _targetChart() { return Drawing._drawTarget || Drawing.chart; }
function setDrawTarget(chart, host) {
  Drawing._drawTarget = chart || null;
  Drawing._drawHost = host || 'main';
}
Drawing.setDrawTarget = setDrawTarget;

// Tool integration: a tool is armed on BOTH the main and (open) mini chart, so
// the user draws on whichever one they click into. When one finishes, cancel
// the other chart's still-pending draw so only one overlay is created.
function _cancelDrawOnOtherChart(finishedHost) {
  const miniChart = window.MiniChart && window.MiniChart.chart;
  if (finishedHost === 'main') {
    if (Drawing._miniDrawId && miniChart) { try { miniChart.removeOverlay({ id: Drawing._miniDrawId }); } catch (e) {} }
  } else {
    if (Drawing._mainDrawId && Drawing.chart) { try { Drawing.chart.removeOverlay({ id: Drawing._mainDrawId }); } catch (e) {} }
  }
  Drawing._mainDrawId = null;
  Drawing._miniDrawId = null;
}

// ===== Text box tool — single-click placement =====
// Unlike the other shapes (2-click box / N-point path), the text tool drops a
// box with ONE click at the top-left, then opens the inline editor immediately
// (PPT-style). The box auto-sizes to the text on commit (see _autoSizeTextBox).
let _textPlacementCleanup = null;
function _cancelTextPlacement() {
  if (_textPlacementCleanup) { _textPlacementCleanup(); _textPlacementCleanup = null; }
}
function _placeTextBoxAt(chart, host, mx, my) {
  let out;
  try { out = chart.convertFromPixel({ x: mx, y: my }, { paneId: 'candle_pane' }); }
  catch (e) { return; }
  const tl = Array.isArray(out) ? out[0] : out;
  if (!tl || !Number.isFinite(tl.value)) return;
  // Default box: ~150px wide, one line tall — a placeholder until the text is
  // committed and _autoSizeTextBox recomputes it.
  const brPx = { x: mx + 150, y: my + Math.ceil(20 * 1.2) + 8 };
  let bo;
  try { bo = chart.convertFromPixel(brPx, { paneId: 'candle_pane' }); } catch (e) { return; }
  const br = Array.isArray(bo) ? bo[0] : bo;
  if (!br || !Number.isFinite(br.value)) return;
  const mk = (p) => {
    const o = { value: p.value };
    if (Number.isFinite(p.timestamp)) o.timestamp = p.timestamp;
    if (Number.isFinite(p.dataIndex)) o.dataIndex = p.dataIndex;
    return o;
  };
  const inherit = getInheritedStyle('rectangle_snap');
  const extendData = {
    textBox: true,
    text: { ...DEFAULT_TEXT_STATE, content: '', hAlign: 'left', vPos: 'top' },
    bgEnabled: false, borderEnabled: false, wrap: false,
  };
  Drawing._drawHost = host;
  let id;
  try { id = chart.createOverlay({ name: 'rectangle_snap', points: [mk(tl), mk(br)], extendData }); }
  catch (e) { Drawing._drawHost = 'main'; return; }
  if (typeof id !== 'string') { Drawing._drawHost = 'main'; return; }
  const live = chart.getOverlayById(id);
  if (live) trackOverlay(live);
  Drawing._drawHost = 'main';
  applyAutoZLevels();
  refreshObjectTree();
  // Select it and open the editor on the next tick (the overlay must exist in
  // the registry first).
  setTimeout(() => {
    const entry = Drawing.overlayRegistry.get(id) || (Drawing._miniRegistry && [...Drawing._miniRegistry.values()].find(e => e._ovid === id));
    Drawing.selectedOverlay = chart.getOverlayById(id) || entry;
    if (entry) startRectTextEdit(Drawing.overlayRegistry.get(id) || entry);
  }, 0);
}
function _installTextBoxPlacement() {
  _cancelTextPlacement();
  const targets = [];
  const mainEl = document.getElementById('chart');
  if (mainEl && Drawing.chart) targets.push({ el: mainEl, chart: Drawing.chart, host: 'main' });
  const mc = window.MiniChart && window.MiniChart.chart;
  const miniEl = document.getElementById('mini-chart');
  if (mc && miniEl && window.MiniChart.el && !window.MiniChart.el.hidden) targets.push({ el: miniEl, chart: mc, host: 'mini' });
  const handlers = [];
  for (const tgt of targets) {
    const onClick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const r = tgt.el.getBoundingClientRect();
      _cancelTextPlacement();
      _placeTextBoxAt(tgt.chart, tgt.host, e.clientX - r.left, e.clientY - r.top);
      setTool('cross');
    };
    tgt.el.addEventListener('mousedown', onClick, true);
    handlers.push([tgt.el, onClick]);
  }
  _textPlacementCleanup = () => handlers.forEach(([el, fn]) => el.removeEventListener('mousedown', fn, true));
}

function setTool(tool) {
  _cancelTextPlacement();
  Drawing.activeTool = tool;
  if (Drawing._updateSnapIndicator) Drawing._updateSnapIndicator();

  // Update left toolbar UI — singletons (cross / position-settings / trash)
  // toggle via dataset.tool match; groups are handled by _syncToolGroupTrigger.
  document.querySelectorAll('#leftbar .tool-btn').forEach(btn => {
    // Skip group triggers — they don't have data-tool, and their .active is
    // governed by _syncToolGroupTrigger which is more nuanced (matches the
    // group that owns this tool, not the trigger's own data-tool).
    if (btn.classList.contains('tool-group-trigger')) return;
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  _syncToolGroupTrigger(tool);
  _closeAllToolGroupPopups();
  document.querySelectorAll('#tool-quickbar .quick-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });

  // Disable chart pan/zoom while a drawing tool is active so accidental drag
  // doesn't pan the chart and break path/trendline placement. Applied to BOTH
  // charts since the tool is armed on both (main + open mini).
  {
    const drawing = tool !== 'cross';
    const _dis = (c) => { if (!c) return; try { c.setScrollEnabled(!drawing); } catch (e) {} try { c.setZoomEnabled(!drawing); } catch (e) {} };
    _dis(Drawing.chart);
    const _mc = window.MiniChart && window.MiniChart.chart;
    if (_mc && window.MiniChart.el && !window.MiniChart.el.hidden) _dis(_mc);
  }

  const quickbar = document.getElementById('tool-quickbar');
  if (tool === 'cross') {
    quickbar.classList.add('hidden');
    Drawing._drawTarget = null;   // reset draw target back to the main chart
    Drawing._drawHost = 'main';
    return;
  }

  quickbar.classList.remove('hidden');

  // Text box uses single-click placement, not KLineChart's draw flow.
  if (tool === 'text') { _installTextBoxPlacement(); return; }

  const overlayName = {
    trendline: 'trendline_snap',
    curve: 'curve_snap',
    rectangle: 'rectangle_snap',
    path: 'path_snap',
    measure: 'measure_snap',
    'long-position': 'long_position',
    'short-position': 'short_position',
    'fibo-retrace':   'fibo_retrace',
    'fibo-extension': 'fibo_extension',
    'fibo-time':      'fibo_time',
  }[tool];

  if (overlayName && Drawing.chart) {
    // Reset prior drawing state before starting a new one
    Drawing.drawingId = null;
    Drawing.drawingPoints = [];
    Drawing._mainDrawId = null;
    Drawing._miniDrawId = null;

    const isPositionLong  = overlayName === 'long_position';
    const isPositionShort = overlayName === 'short_position';
    const isPosition = isPositionLong || isPositionShort;
    const isFibo = overlayName === 'fibo_retrace' || overlayName === 'fibo_extension' || overlayName === 'fibo_time';

    const inherit = getInheritedStyle(overlayName);

    // Arm the tool on BOTH charts (main + open mini). The user draws on
    // whichever they click into; whichever finishes gets tracked to its
    // host's registry, and the other chart's pending draw is cancelled.
    const makeOpts = (host, hostChart) => {
      const o = {
        name: overlayName,
        onDrawStart: (event) => {
          const ov = event && (event.overlay || event);
          if (ov && ov.id) {
            Drawing.drawingId = ov.id;
            if (host === 'mini') Drawing._miniDrawId = ov.id; else Drawing._mainDrawId = ov.id;
          }
          if (ov && ov.points) Drawing.drawingPoints = ov.points.slice();
        },
        onDrawing: (event) => {
          const ov = event && (event.overlay || event);
          if (ov && ov.id) Drawing.drawingId = ov.id;
          if (ov && ov.points) Drawing.drawingPoints = ov.points.slice();
        },
        onDrawEnd: (event) => {
          const ov = event && (event.overlay || event);
          Drawing._drawHost = host;   // trackOverlay routes by this
          // Position overlays drop with 1 stored point — auto-fill target+stop.
          if (ov && isPosition && ov.points && ov.points.length === 1) {
            _autoFillPositionPoints(ov, isPositionLong ? 'long' : 'short', hostChart);
          }
          // Fibo overlays — seed extendData on first draw if missing, using the
          // LAST-USED config (levels/colours the user last set up) so a new fibo
          // inherits it; falls back to defaults when nothing has been used.
          if (ov && isFibo) {
            if (!ov.extendData || !ov.extendData.fibo || !ov.extendData.levels) {
              const seeded = _fiboSeedFor(overlayName);
              try { hostChart.overrideOverlay({ id: ov.id, extendData: seeded }); }
              catch (e) { /* ignore */ }
              ov.extendData = seeded;
            }
          }
          if (ov && ov.id) trackOverlay(ov);
          _cancelDrawOnOtherChart(host);
          Drawing.drawingId = null;
          Drawing.drawingPoints = [];
          Drawing._drawHost = 'main';
          setTimeout(() => {
            setTool('cross');
            // A freshly drawn rectangle would otherwise sit above everything
            // already inside it (topmost-first hit test) — re-rank by area.
            if (host === 'main') { try { applyAutoZLevels(); } catch (e) {} }
            refreshObjectTree();
          }, 50);
        },
      };
      // Inherit style from the last-customized shape of this type (text content
      // intentionally NOT inherited — each new shape starts with an empty label).
      if (inherit) {
        if (inherit.styles) o.styles = inherit.styles;
        if (inherit.extendData) o.extendData = inherit.extendData;
      }
      // Fibo: seed the LAST-USED config on the in-progress overlay so the DRAW
      // PREVIEW already shows the saved levels (not defaults). Without this the
      // in-progress fibo has no extendData → buildFiboFigures falls back to
      // defaults while dragging, and only the finalized overlay picks up
      // last-used (Aaron: "拉的時候跑出預設, 拉完才變成存的範例").
      if (isFibo && !o.extendData) {
        o.extendData = _fiboSeedFor(overlayName);
      }
      return o;
    };

    Drawing.chart.createOverlay(makeOpts('main', Drawing.chart));
    const miniChart = window.MiniChart && window.MiniChart.chart;
    if (miniChart && window.MiniChart.el && !window.MiniChart.el.hidden) {
      miniChart.createOverlay(makeOpts('mini', miniChart));
    }
  }
}

// ===== Init =====
// Idempotent guard for the i18n:change listener — protects against
// double-init (multi-init / hot reload) which would compound the
// re-render cost on every language toggle.
let _drawingI18nWired = false;

function init(chart) {
  Drawing.chart = chart;
  registerOverlays();

  // Branch-scoped position overlays: re-filter visibility whenever the
  // active branch changes (hide other branches' boxes, show this one's).
  if (!Drawing._branchFilterWired && window.BranchEngine && window.BranchEngine.on) {
    Drawing._branchFilterWired = true;
    window.BranchEngine.on('activeBranchChanged', () => {
      try { applyBranchFilter(); } catch (e) {}
    });
    // Cascade-delete a deleted branch's overlays (main + mini). The engine
    // re-parents children but overlays are removed, not re-parented.
    window.BranchEngine.on('branchDeleted', (payload) => {
      try { removeBranchOverlays(payload && payload.id); } catch (e) {}
    });
  }

  // Spec i18n §4.3: on language change, re-render every drawing UI
  // surface that uses dynamic labels — shortcut catalog, object tree,
  // context-menu lock/hide labels, and the open drawing-settings panel
  // title (uses getOverlayDisplayName which now reads via I18n.t).
  if (!_drawingI18nWired) {
    _drawingI18nWired = true;
    document.addEventListener('i18n:change', () => {
      try { _renderShortcutsBody(); } catch (e) {}
      try { refreshObjectTree(); }   catch (e) {}
      try { refreshContextMenuLabels(); } catch (e) {}
      // Re-set the drawing settings panel title if a panel is open.
      const titleEl = document.getElementById('sp-title');
      if (titleEl && Drawing.selectedOverlay) {
        titleEl.textContent = getOverlayDisplayName(Drawing.selectedOverlay);
      }
    });
  }

  // Preload Noto Sans SC so the first rectangle-text measureText call uses the
  // real font widths (not a fallback). After load, force a repaint so any
  // already-rendered labels re-measure with the correct glyph widths.
  if (document.fonts && document.fonts.load) {
    Promise.all([
      document.fonts.load('400 20px "Noto Sans SC"'),
      document.fonts.load('900 20px "Noto Sans SC"'),
    ]).then(() => {
      try { chart.setStyles({}); } catch (e) { /* ignore */ }
    }).catch(() => { /* fallback font still works */ });
  }

  // ---- Left toolbar buttons ----
  // Singletons (cross / position-settings / trash) carry data-tool directly;
  // group triggers don't (they only open a popup). Filter `data-tool` so we
  // don't bind a setTool handler to triggers.
  document.querySelectorAll('#leftbar .tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });
  document.querySelectorAll('#tool-quickbar .quick-btn').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  // Mac users see ⌥ for Alt, ⌘ for Ctrl — reuse the dictionary's
  // macifyShortcutString so the popup labels match the shortcut help
  // window's already-macified style.
  if (window.I18n && window.I18n.macifyShortcutString) {
    document.querySelectorAll('.popup-tool-hotkey').forEach(el => {
      el.textContent = window.I18n.macifyShortcutString(el.textContent);
    });
  }

  // ---- Tool-group triggers (open popup on click) ----
  document.querySelectorAll('.tool-group-trigger').forEach(trigger => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const groupEl = trigger.closest('.tool-group');
      if (!groupEl) return;
      _toggleToolGroupPopup(groupEl.dataset.group);
    });
  });

  // ---- Tool-group popup items (activate tool + close popup) ----
  document.querySelectorAll('.tool-popup-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const tool = item.dataset.tool;
      if (!tool) return;
      setTool(tool);   // also calls _closeAllToolGroupPopups internally
    });
  });

  // ---- Outside-click closes any open tool-group popup ----
  // Capture-phase + ignore clicks inside any .tool-group (trigger or popup)
  // so the trigger's own toggle handler isn't double-fired.
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('.tool-group')) return;
    _closeAllToolGroupPopups();
  }, true);

  // ---- Clear all ----
  document.getElementById('btn-clear-all').addEventListener('click', () => {
    const msg = (window.I18n && window.I18n.t)
      ? window.I18n.t('dlg.confirmClearAll')
      : '清除所有畫線？';
    if (confirm(msg)) {
      chart.removeOverlay();
      Drawing.overlayRegistry.clear();
      refreshObjectTree();
      schedulePersist();
    }
  });

  // ---- Hotkeys (Alt+T/R/P, Esc, Del) ----
  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement || {}).tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;

    if (e.altKey && !e.shiftKey && !e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === 't') { setTool('trendline'); e.preventDefault(); return; }
      // Rectangle: Alt+R, plus Alt+G as a backup — some systems have a global
      // hotkey (screen-recorders / GPU overlays like GeForce ShadowPlay) that
      // swallows Alt+R before the page ever sees it.
      if (k === 'r' || k === 'g') { setTool('rectangle'); e.preventDefault(); return; }
      if (k === 'c') { setTool('curve'); e.preventDefault(); return; }
      if (k === 'p') { setTool('path'); e.preventDefault(); return; }
      if (k === 'm') { setTool('measure'); e.preventDefault(); return; }
      if (k === 'l') { setTool('long-position'); e.preventDefault(); return; }
      if (k === 's') { setTool('short-position'); e.preventDefault(); return; }
      if (k === 'f') { setTool('fibo-retrace');   e.preventDefault(); return; }
      if (k === 'e') { setTool('fibo-extension'); e.preventDefault(); return; }
      if (k === 'i') { setTool('fibo-time');      e.preventDefault(); return; }
      if (k === 'x') { setTool('text');           e.preventDefault(); return; }
    }
    if (e.key === 'Escape') {
      // If a path is in progress, finalize it with current points
      finalizeInProgressPath();
      setTool('cross');
      hideSettings();
      return;
    }
    if (e.key === 'Delete' && Drawing.selectedOverlay) {
      // Route through removeSelected() so the deletion is recorded
      // on the undo stack (Ctrl+Z restores the overlay). The inline
      // chart.removeOverlay path used to bypass pushUndo, leaving
      // accidental Delete-key presses unrecoverable.
      removeSelected();
      hideSettings();
    }
  });

  // ---- Snap modifier tracking ----
  const snapInd = document.getElementById('snap-indicator');
  const updateSnapIndicator = () => {
    // Only surface the SNAP pill when a drawing tool is active — otherwise
    // just holding Ctrl/Shift while panning/inspecting would flash it.
    const drawing = Drawing.activeTool !== 'cross';
    const on = drawing && (window.SnapState.ctrlHeld || window.SnapState.shiftHeld);
    snapInd.classList.toggle('hidden', !on);
    if (on) {
      const labels = [];
      if (window.SnapState.ctrlHeld) labels.push('OHLC');
      if (window.SnapState.shiftHeld) labels.push('AXIS');
      snapInd.textContent = labels.join(' + ');
    }
  };
  Drawing._updateSnapIndicator = updateSnapIndicator;
  document.addEventListener('keydown', (e) => {
    let changed = false;
    if (isOhlcSnapKey(e) && !window.SnapState.ctrlHeld) {
      window.SnapState.ctrlHeld = true; changed = true;
    }
    if (isAxisLockKey(e) && !window.SnapState.shiftHeld) {
      window.SnapState.shiftHeld = true; changed = true;
    }
    if (changed) updateSnapIndicator();
  });
  document.addEventListener('keyup', (e) => {
    let changed = false;
    if (!isOhlcSnapKey(e) && window.SnapState.ctrlHeld) {
      window.SnapState.ctrlHeld = false; changed = true;
    }
    if (!isAxisLockKey(e) && window.SnapState.shiftHeld) {
      window.SnapState.shiftHeld = false; changed = true;
    }
    if (changed) updateSnapIndicator();
  });
  // Reset on blur
  window.addEventListener('blur', () => {
    window.SnapState.ctrlHeld = false;
    window.SnapState.shiftHeld = false;
    updateSnapIndicator();
  });

  // ---- Double-click on chart finalizes an in-progress path ----
  // BUT only when the two clicks were at nearly the same spot — otherwise
  // rapid clicks at different positions (the user laying down points fast)
  // would trip the browser's dblclick threshold and finalize prematurely.
  const chartElForDbl = document.getElementById('chart');
  // Dblclick-finishes-a-path, installed per chart (its own recent-click buffer)
  // so the path tool finishes with a double-click on the mini too.
  // finalizeInProgressPath is chart-aware (Drawing._pathHost).
  function _installPathClickHandlers(el) {
    const recentClicks = [];   // last 2 click positions on THIS chart
    el.addEventListener('click', (e) => {
      recentClicks.push({ x: e.clientX, y: e.clientY });
      if (recentClicks.length > 2) recentClicks.shift();
    });
    el.addEventListener('dblclick', () => {
      if (recentClicks.length >= 2) {
        const [a, b] = recentClicks;
        if (Math.hypot(b.x - a.x, b.y - a.y) > 8) return;
      }
      finalizeInProgressPath();
      setTool('cross');
    });
  }
  _installPathClickHandlers(chartElForDbl);
  const _miniElForPathClick = document.getElementById('mini-chart');
  if (_miniElForPathClick) _installPathClickHandlers(_miniElForPathClick);

  // ---- Drawing point placement: we own it entirely for path/trendline/rect ----
  // KLineChart's built-in click-adds-a-point requires mousedown and mouseup at
  // almost the same spot; fast clicks (esp. trackpad) can move 20–100 px and
  // KLineChart drops them as drags. Simpler model: every left-mousedown in a
  // drawing tool mode commits ONE point at that position. Holding + dragging
  // does nothing; the next point requires a new mousedown. For trendline and
  // rectangle we auto-finalize once the target point count is reached.
  const DRAW_TOOL_FINISH_POINTS = {
    curve: 2,   // 2 clicks (A, C); the apex B is auto-seeded with a bow
    trendline: 2,
    rectangle: 2,
    path: null,          // path never auto-finishes — user triggers finalize
    'fibo-retrace':   2,  // 2 points = high + low
    'fibo-extension': 3,  // 3 points = trend start + trend end + projection
    'fibo-time':      3,  // 3 points = interval start + end + projection origin
  };
  const DRAW_TOOL_OVERLAY_NAME = {
    trendline: 'trendline_snap',
    curve:     'curve_snap',
    rectangle: 'rectangle_snap',
    path:      'path_snap',
    measure:   'measure_snap',
    'long-position':  'long_position',
    'short-position': 'short_position',
    'fibo-retrace':   'fibo_retrace',
    'fibo-extension': 'fibo_extension',
    'fibo-time':      'fibo_time',
  };

  // Point-placement takeover, installed on BOTH the main chart and the mini
  // chart so drawing behaves identically on either: 2-click curve (A,C) with an
  // auto-seeded bow, fast-click robustness, and Ctrl/Shift snap. The chart, its
  // in-progress overlay id, and its bar list are all resolved from the container
  // the event fired on — main uses Drawing.drawingId + App.currentBars, the mini
  // uses Drawing._miniDrawId + the mini's own getDataList().
  function _handleDrawMousedown(e, containerEl) {
    const tool = Drawing.activeTool;
    if (!(tool in DRAW_TOOL_FINISH_POINTS)) return;
    if (e.button !== 0) return;
    const isMini = !!(containerEl && containerEl.id === 'mini-chart');
    const chart = isMini ? (window.MiniChart && window.MiniChart.chart) : Drawing.chart;
    const host = isMini ? 'mini' : 'main';
    const drawingId = isMini ? Drawing._miniDrawId : Drawing.drawingId;
    if (!chart || !drawingId) return;
    // Remember which chart the path is being drawn on so its finalize
    // (right-click / dblclick / Esc, all of which call finalizeInProgressPath)
    // targets THIS chart. Path never auto-finalizes here (maxPts null).
    if (tool === 'path') Drawing._pathHost = host;

    // Take over — stop KLineChart from running its own click-adds-a-point
    // handler (which will race us and create duplicates on clean clicks).
    e.stopPropagation();
    e.stopImmediatePropagation();

    const rect = containerEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let pt;
    try {
      const out = chart.convertFromPixel({ x: mx, y: my }, { paneId: 'candle_pane' });
      pt = Array.isArray(out) ? out[0] : out;
    } catch (err) { return; }
    if (!pt || !Number.isFinite(pt.value)) return;

    // Apply snap modifiers the same way KLineChart's applySnap would. Snap bars
    // come from the chart being drawn on (the mini has its own bar window).
    const ss = window.SnapState;
    const bars = isMini
      ? (chart.getDataList ? chart.getDataList() : [])
      : (window.App && window.App.currentBars);
    const committedSoFar = Drawing.drawingPoints.slice();
    if (committedSoFar.length > 0) committedSoFar.pop();    // drop preview
    if (ss && ss.ctrlHeld && bars && bars.length) {
      const bar = bars[pt.dataIndex];
      if (bar) pt.value = snapToOHLC(bar, pt.value);
    }
    if (ss && ss.shiftHeld && committedSoFar.length > 0) {
      const ref = committedSoFar[committedSoFar.length - 1];
      const dx = Math.abs(pt.dataIndex - ref.dataIndex);
      const refSpan = Math.max(Math.abs(ref.value) * 0.0005, 0.5);
      const dy = Math.abs(pt.value - ref.value) / refSpan;
      if (dy < dx) { pt.value = ref.value; }
      else         { pt.dataIndex = ref.dataIndex; pt.timestamp = ref.timestamp; }
    }

    let newPts = [...committedSoFar, pt];   // may be reseeded (curve apex) below
    try {
      chart.overrideOverlay({ id: drawingId, points: newPts });
      Drawing.drawingPoints = newPts;
    } catch (err) { /* ignore */ }

    // Auto-finalize when the shape has collected all its points (trendline/rect).
    // KLineChart still thinks the overlay is "mid-drawing" because its
    // currentStep wasn't incremented through the normal click path — that'll
    // cause it to be wiped when the user starts drawing a new shape. Fix by
    // removing + recreating the overlay so KLineChart sees all points present
    // and marks it complete.
    const maxPts = DRAW_TOOL_FINISH_POINTS[tool];
    if (maxPts != null && newPts.length >= maxPts) {
      const overlayName = DRAW_TOOL_OVERLAY_NAME[tool];
      // Curve finishes on 2 clicks (A,C) → inject the bowed apex B (computed in
      // THIS chart's pixel space) so the completed overlay is a curve.
      if (overlayName === 'curve_snap' && newPts.length === 2) {
        newPts = _seedCurveApex(newPts[0], newPts[1], chart) || newPts;
      }
      // Read current styles/extendData (inheritance applied at create-time is
      // preserved on the live overlay). Fall back to getInheritedStyle().
      // NB: klinecharts 9.8.10 has NO chart.getOverlays() — use getOverlayById.
      let ovStyles, ovExtendData;
      try {
        const match = chart.getOverlayById && chart.getOverlayById(drawingId);
        if (match) { ovStyles = match.styles; ovExtendData = match.extendData; }
      } catch (err) { /* ignore */ }
      if (!ovStyles || !ovExtendData) {
        const inh = getInheritedStyle(overlayName);
        if (!ovStyles     && inh && inh.styles)     ovStyles     = inh.styles;
        if (!ovExtendData && inh && inh.extendData) ovExtendData = inh.extendData;
      }
      // Fibo has no DRAWING_INHERITED bucket and the in-progress overlay carries
      // no extendData, so seed the LAST-USED fibo config HERE. This auto-finalize
      // path takes over the click (stopImmediatePropagation) and creates the
      // completed overlay itself, bypassing setTool's onDrawEnd fibo seed — which
      // is why a new fibo always reverted to defaults (Aaron's bug).
      if (!ovExtendData && (overlayName === 'fibo_retrace' || overlayName === 'fibo_extension' || overlayName === 'fibo_time')) {
        ovExtendData = _fiboSeedFor(overlayName);
      }

      // Remove the in-progress overlay and create a completed one with all
      // points present.
      try { chart.removeOverlay({ id: drawingId }); } catch (err) { /* ignore */ }
      untrackOverlay(drawingId);
      Drawing.drawingId = null;
      Drawing.drawingPoints = [];

      const opts = { name: overlayName, points: newPts };
      if (ovStyles)     opts.styles     = ovStyles;
      if (ovExtendData) opts.extendData = ovExtendData;
      let newId;
      try { newId = chart.createOverlay(opts); } catch (err) { /* ignore */ }
      if (typeof newId === 'string') {
        // Route trackOverlay to the right registry (main vs _miniRegistry).
        Drawing._drawHost = host;
        trackOverlay({
          id: newId, name: overlayName, points: newPts,
          styles: ovStyles, extendData: ovExtendData,
          visible: true, lock: false,
        });
        Drawing._drawHost = 'main';
      }
      // Drop the OTHER chart's still-armed in-progress overlay (setTool arms
      // both when the mini is open) so it doesn't leave a stray half-drawn shape.
      _cancelDrawOnOtherChart(host);
      setTimeout(() => {
        setTool('cross');
        refreshObjectTree();
      }, 50);
    }
  }
  chartElForDbl.addEventListener('mousedown', (e) => _handleDrawMousedown(e, chartElForDbl), true);
  const _miniElForDraw = document.getElementById('mini-chart');
  if (_miniElForDraw) _miniElForDraw.addEventListener('mousedown', (e) => _handleDrawMousedown(e, _miniElForDraw), true);

  // ---- Right-click: finalize path / cancel other in-progress draws + suppress OS menu ----
  // KLineChart 9.x uses pointerdown internally; intercept BEFORE it bubbles by
  // listening with capture:true on the chart container.
  //   - Path:  right-click finalizes (TradingView convention — the last
  //            clicked point becomes the path's end).
  //   - Other tools mid-draw (measure / trendline / rectangle / fibo /
  //            long-position / short-position): right-click CANCELS — drops
  //            the in-progress overlay and returns to cursor mode. KLineChart's
  //            own engine also cancels on right-click but doesn't reset our
  //            Drawing.activeTool / Drawing.drawingId, leaving stale state
  //            that confuses the next user action; this handler keeps both
  //            sides in sync. Especially relevant for the Shift+Click measure
  //            shortcut where the overlay is created with only point A seeded.
  //
  // After either action we set `_suppressNextContextMenu` so the
  // contextmenu handler below skips opening the chart-area settings popup
  // on the SAME right-click — clicking right to cancel/finalize and then
  // immediately being asked "open chart settings?" is bad UX.
  const chartEl = document.getElementById('chart');
  let _suppressNextContextMenu = false;
  // containerEl resolves which chart the right-click landed on: path finalize
  // is chart-aware (finalizeInProgressPath reads Drawing._pathHost); the
  // mid-draw cancel drops the in-progress overlay on the RIGHT chart.
  const blockRightDown = (e, containerEl) => {
    if (e.button !== 2) return;
    const isMini = !!(containerEl && containerEl.id === 'mini-chart');
    if (Drawing.activeTool === 'path') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      finalizeInProgressPath();
      setTool('cross');
      _suppressNextContextMenu = true;
      return;
    }
    // Any other drawing tool currently mid-draw → cancel.
    const id = isMini ? Drawing._miniDrawId : Drawing.drawingId;
    if (Drawing.activeTool !== 'cross' && id) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const chart = isMini ? (window.MiniChart && window.MiniChart.chart) : Drawing.chart;
      try { chart.removeOverlay({ id }); } catch (err) {}
      try { untrackOverlay(id); } catch (err) {}
      if (isMini) Drawing._miniDrawId = null; else Drawing.drawingId = null;
      Drawing.drawingPoints = [];
      setTool('cross');
      _suppressNextContextMenu = true;
    }
  };
  chartEl.addEventListener('pointerdown', (e) => blockRightDown(e, chartEl), true);
  chartEl.addEventListener('mousedown', (e) => blockRightDown(e, chartEl), true);
  // Same right-click finish/cancel on the mini chart, plus swallow its OS
  // context menu (the mini has no chart-area settings popup of its own).
  const _miniElForRight = document.getElementById('mini-chart');
  if (_miniElForRight) {
    _miniElForRight.addEventListener('pointerdown', (e) => blockRightDown(e, _miniElForRight), true);
    _miniElForRight.addEventListener('mousedown', (e) => blockRightDown(e, _miniElForRight), true);
    _miniElForRight.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (_suppressNextContextMenu) _suppressNextContextMenu = false;
    }, true);
  }
  chartEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // One-shot suppression — when right-click just finalized a path or
    // cancelled an in-progress draw, the user expects the action to be
    // their full intent, not a prelude to "open chart settings menu".
    // Flag is set by blockRightDown above; we read + clear it here.
    if (_suppressNextContextMenu) {
      _suppressNextContextMenu = false;
      return;
    }
    // Per-overlay onRightClick fires from the canvas hit-test path and
    // synchronously opens #ctx-menu. Defer one frame so we can detect
    // whether that happened: if the overlay menu is now visible, the
    // user clicked on a drawing → don't show the chart-area menu.
    // Otherwise (empty area) → show it at the mouse position.
    requestAnimationFrame(() => {
      const overlayMenu = document.getElementById('ctx-menu');
      if (overlayMenu && !overlayMenu.classList.contains('hidden')) return;
      showChartContextMenu(e.pageX, e.pageY);
    });
  }, true);

  // ---- Crosshair tracking (used as paste target position) ----
  chart.subscribeAction('onCrosshairChange', (data) => {
    if (data && Number.isFinite(data.dataIndex)) {
      Drawing.lastCrosshair = {
        dataIndex: data.dataIndex,
        value: data.value,
        timestamp: data.timestamp,
      };
    }
  });

  // ---- Mouse position tracker (used to position the right-click menu) ----
  document.addEventListener('mousemove', (e) => {
    Drawing.lastMousePage.pageX = e.pageX;
    Drawing.lastMousePage.pageY = e.pageY;
  }, true);

  // ---- Rectangle 8-handle custom drag (corners + edge mid-points) ----
  initRectHandleDrag();

  // ---- Context menu wiring ----
  initContextMenu();
  initChartContextMenu();
  initChartSettingsModal();
  initShortcutsWindow();
  _initUndoKeybindings();

  // Restore the user's persisted chart settings (K-bar colors + bg).
  // Safe to call before any drawings exist; uses chart.setStyles which
  // is already alive after app.js's init() finished.
  loadChartSettings();
  applyChartSettings(_chartSettings.current);

  // ---- Ctrl+C/X/V/D for selected overlay ----
  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement || {}).tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'c') { copySelected(); e.preventDefault(); }
    else if (k === 'x') { cutSelected(); e.preventDefault(); }
    else if (k === 'v') { pasteAtCrosshair(); e.preventDefault(); }
    else if (k === 'd') { cloneSelected(); e.preventDefault(); }
  });

  // Settings panel wiring
  initSettingsPanel(chart);
  initObjectTree(chart);

  // Migrate any legacy (global-key) saved drawings to the current symbol's
  // key the first time we boot post-multi-symbol.
  _migrateLegacyOverlays();
  // Sync drawing templates from backend (first run may push cached ones up).
  _syncTemplatesFromServer();
  // Restore any overlays saved from a previous session (only after bars are
  // loaded so we can re-map timestamps to the current TF's dataIndex).
  restoreOverlays();
}

// =================================================================
// Rectangle custom drag — 8 handles via capture-phase mouse listeners
// =================================================================
// KLineChart 9.x's performEventPressedMove only fires for default handles
// (needDefaultPointFigure:true). To get 8 draggable handles we hit-test
// mouse events against computed handle positions ourselves.
let _rectDrag = null;    // { overlayId, handleIdx }
let _rectHoverCursor = '';
let _miniHoverCursor = '';   // mini-chart hover cursor (rect resize arrow / pointer)
let _rectEditingId = null;    // id of rect currently in inline-text-edit mode
let _rectEditHost = null;     // host <div> of rect inline editor (for live reposition during drag)
let _trendEditingId = null;   // id of trendline currently in inline-text-edit mode
let _trendEditingState = null; // live text state during trendline edit (for line break)
const HANDLE_HIT_RADIUS_SQ = 64;    // 8 px

// Reposition the rect inline editor host to match the rect's current pixel
// bounds — called during rect handle drag so the textarea follows the shape.
function repositionRectEditor() {
  if (!_rectEditHost || !_rectEditingId) return;
  const entry = Drawing.overlayRegistry.get(_rectEditingId);
  if (!entry || !entry.points || entry.points.length < 2) return;
  const chartEl = document.getElementById('chart');
  if (!chartEl) return;
  const px = computeRectHandlePixels(entry.points[0], entry.points[1]);
  if (!px) return;
  const xL = Math.min(px[0].x, px[3].x);
  const xR = Math.max(px[0].x, px[3].x);
  const yT = Math.min(px[0].y, px[3].y);
  const yB = Math.max(px[0].y, px[3].y);
  const chartRect = chartEl.getBoundingClientRect();
  _rectEditHost.style.left   = (chartRect.left + xL) + 'px';
  _rectEditHost.style.top    = (chartRect.top  + yT) + 'px';
  _rectEditHost.style.width  = (xR - xL) + 'px';
  _rectEditHost.style.height = (yB - yT) + 'px';
}

// Handle idx → CSS cursor:
//   1 TL / 4 BR  → nwse-resize (對角線縮放 ↖↘)
//   2 TR / 3 BL  → nesw-resize (對角線縮放 ↗↙)
//   5 T  / 6 B   → ns-resize   (垂直調整)
//   7 L  / 8 R   → ew-resize   (水平調整)
const RECT_HANDLE_CURSOR = {
  1: 'nwse-resize', 2: 'nesw-resize',
  3: 'nesw-resize', 4: 'nwse-resize',
  5: 'ns-resize',   6: 'ns-resize',
  7: 'ew-resize',   8: 'ew-resize',
};
function cursorForRectHandle(idx) { return RECT_HANDLE_CURSOR[idx] || ''; }

// Find which handle (if any) the pointer is currently on. Only the SELECTED
// rectangle has visible handles (matches trendline/path), so we only hit-test
// that one. Clicking a non-selected rect's would-be handle area hits the body
// instead — KLineChart's onSelected fires, the rect becomes selected, and the
// handles appear for the next interaction.
function hitTestRectHandle(mx, my) {
  const sel = Drawing.selectedOverlay;
  if (!sel || sel.name !== 'rectangle_snap') return null;
  // chart-aware: a mini rect's id isn't in overlayRegistry — resolve which
  // chart it's on, then take its live points (with dataIndex) from that chart's
  // overlay so the handle pixels are computed in the right coordinate space.
  const chart = _chartOf(sel.id);
  const isMini = chart !== Drawing.chart;
  let entry, points;
  if (isMini) {
    let me = null;
    if (Drawing._miniRegistry) for (const e of Drawing._miniRegistry.values()) { if (e._ovid === sel.id) { me = e; break; } }
    if (!me || me.lock || me.visible === false) return null;
    const miniOv = chart.getOverlayById && chart.getOverlayById(sel.id);
    if (!miniOv || !miniOv.points || miniOv.points.length < 2) return null;
    entry = me; points = miniOv.points;
  } else {
    entry = Drawing.overlayRegistry.get(sel.id);
    if (!entry || entry.lock || entry.visible === false) return null;
    if (!entry.points || entry.points.length < 2) return null;
    points = entry.points;
  }
  const handles = computeRectHandlePixels(points[0], points[1], chart);
  if (!handles) return null;
  let best = null;
  for (const h of handles) {
    const dx = h.x - mx, dy = h.y - my;
    const d = dx * dx + dy * dy;
    if (d > HANDLE_HIT_RADIUS_SQ) continue;
    if (!best || d < best.distSq) {
      best = { overlayId: sel.id, entry, points, handle: h, distSq: d, isSel: true, chart, isMini };
    }
  }
  return best;
}

// Is the pointer inside ANY tracked rectangle's body? Used to paint `pointer`
// cursor when hovering a rectangle (but not on a handle — handles win).
function hitTestRectBody(mx, my, chart) {
  chart = chart || Drawing.chart;
  const isMini = chart !== Drawing.chart;
  const rects = [];
  if (isMini) {
    if (Drawing._miniRegistry) for (const e of Drawing._miniRegistry.values()) {
      if (e.name !== 'rectangle_snap' || e.visible === false || !e._ovid) continue;
      const ov = chart.getOverlayById && chart.getOverlayById(e._ovid);
      if (ov && ov.points && ov.points.length >= 2) rects.push({ points: ov.points, ref: e });
    }
  } else {
    for (const e of Drawing.overlayRegistry.values()) {
      if (e.name !== 'rectangle_snap' || e.visible === false || !e.points || e.points.length < 2) continue;
      rects.push({ points: e.points, ref: e });
    }
  }
  for (const r of rects) {
    const px = computeRectHandlePixels(r.points[0], r.points[1], chart);
    if (!px) continue;
    // handles[0]=TL, [3]=BR — enough to get bounds
    const xL = Math.min(px[0].x, px[3].x);
    const xR = Math.max(px[0].x, px[3].x);
    const yT = Math.min(px[0].y, px[3].y);
    const yB = Math.max(px[0].y, px[3].y);
    if (mx >= xL && mx <= xR && my >= yT && my <= yB) return r.ref;
  }
  return null;
}

function computeRectHandlePixels(p1, p2, chart) {
  chart = chart || Drawing.chart;
  try {
    const out = chart.convertToPixel(
      [{ dataIndex: p1.dataIndex, value: p1.value },
       { dataIndex: p2.dataIndex, value: p2.value }],
      { paneId: 'candle_pane' }
    );
    const a = Array.isArray(out) ? out[0] : null;
    const b = Array.isArray(out) ? out[1] : null;
    if (!a || !b) return null;
    const xL = Math.min(a.x, b.x), xR = Math.max(a.x, b.x);
    const yT = Math.min(a.y, b.y), yB = Math.max(a.y, b.y);
    const cx = (xL + xR) / 2, cy = (yT + yB) / 2;
    return [
      { idx: 1, x: xL, y: yT },  // TL
      { idx: 2, x: xR, y: yT },  // TR
      { idx: 3, x: xL, y: yB },  // BL
      { idx: 4, x: xR, y: yB },  // BR
      { idx: 5, x: cx, y: yT },  // T
      { idx: 6, x: cx, y: yB },  // B
      { idx: 7, x: xL, y: cy },  // L
      { idx: 8, x: xR, y: cy },  // R
    ];
  } catch (e) { return null; }
}

function initRectHandleDrag() {
  const chartEl = document.getElementById('chart');

  // ---- Shift + Left-click / drag shortcut → invoke measure tool ----
  // TradingView convention: Shift+drag on chart opens a date/price range
  // measurement. Two UX modes coalesced into one gesture:
  //   • Shift+click (down + up at ~same spot) → seed point A, wait for
  //     user to click point B (KLineChart's standard 2-click flow).
  //   • Shift+drag  (down at A, move, release at B) → seed point A,
  //     finalize point B on mouseup so the whole gesture is one motion.
  // Capture phase so we beat KLineChart's own pan / select handlers; we
  // call stopImmediatePropagation on mousedown to prevent the _chartDrag
  // pan listener below from also firing.
  let _shiftMeasureDrag = null;     // { downX, downY, pointA } while a Shift+gesture is in progress
  const _coordFromEvent = (e) => {
    const rect = chartEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let coord = null;
    try {
      coord = Drawing.chart.convertFromPixel({ x: mx, y: my }, { paneId: 'candle_pane' });
    } catch (err) { return null; }
    if (!coord || !Number.isFinite(coord.value)) return null;
    const bars = (window.App && window.App.currentBars) || [];
    let timestamp = coord.timestamp;
    if (!Number.isFinite(timestamp) && Number.isFinite(coord.dataIndex)) {
      const bar = bars[Math.round(coord.dataIndex)];
      if (bar) timestamp = bar.timestamp;
    }
    if (!Number.isFinite(timestamp)) return null;
    return { timestamp, value: coord.value, dataIndex: coord.dataIndex };
  };
  chartEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (!e.shiftKey) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;       // pure Shift only
    if (Drawing.activeTool !== 'cross') return;           // another tool already active
    if (window.Replay && window.Replay.picking) return;   // replay pick-mode wins
    if (!Drawing.chart) return;
    const pointA = _coordFromEvent(e);
    if (!pointA) return;
    // Block KLineChart's mousedown chain (pan, crosshair, etc.) so the user's
    // shift+drag doesn't double-drive panning AND drawing.
    e.preventDefault();
    e.stopImmediatePropagation();
    _startMeasureAtPoint(pointA);
    _shiftMeasureDrag = { downX: e.clientX, downY: e.clientY, pointA };
  }, true);
  // Mouseup → if user actually dragged (moved >4 px), commit point B at the
  // release position via remove+recreate (same pattern as the click-takeover
  // for trendline/rectangle: KLineChart treats `createOverlay({points:[A,B]})`
  // on a totalStep:3 overlay as immediately complete, fires onDrawEnd). If
  // the user barely moved, treat as a click-and-wait — KLineChart's normal
  // 2-click drawing flow handles the second click.
  window.addEventListener('mouseup', (e) => {
    if (!_shiftMeasureDrag) return;
    const state = _shiftMeasureDrag;
    _shiftMeasureDrag = null;
    const dist = Math.hypot(e.clientX - state.downX, e.clientY - state.downY);
    if (dist < 4) return;
    const pointB = _coordFromEvent(e);
    if (!pointB) return;
    _finalizeShiftMeasureDrag(state.pointA, pointB);
  });

  // ---- Chart-body drag (pan left/right) cursor: grabbing ----
  // When the user holds the left button on an empty chart area and moves,
  // KLineChart pans the bars. Swap the cursor to `grabbing` for that session
  // so the interaction feels right.
  let _chartDrag = null;        // { x0, y0, active }
  chartEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (Drawing.activeTool !== 'cross') return;       // drawing tool active
    if (window.Replay && window.Replay.picking) return;
    if (_rectDrag || _overlayDrag) return;             // already in an overlay drag
    // Don't hijack when hovering a rect handle (will become resize drag) or
    // a trendline hot-zone (those flows drive their own cursor).
    const rect = chartEl.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (typeof hitTestRectHandle === 'function' && hitTestRectHandle(mx, my)) return;
    if (_trendlineHoverId) return;
    _chartDrag = { x0: e.clientX, y0: e.clientY, active: false };
  });
  window.addEventListener('mousemove', (e) => {
    if (!_chartDrag) return;
    const dx = e.clientX - _chartDrag.x0;
    const dy = e.clientY - _chartDrag.y0;
    if (!_chartDrag.active && Math.hypot(dx, dy) > 3) {
      _chartDrag.active = true;
      setGlobalCursor('grabbing');
    }
  });
  window.addEventListener('mouseup', () => {
    if (_chartDrag && _chartDrag.active) setGlobalCursor('');
    _chartDrag = null;
  });

  // Exposed for console troubleshooting: `__rectDebug()` returns a snapshot.
  window.__rectDebug = () => ({
    activeTool: Drawing.activeTool,
    selectedOverlay: Drawing.selectedOverlay && {
      id: Drawing.selectedOverlay.id,
      name: Drawing.selectedOverlay.name,
      points: Drawing.selectedOverlay.points,
    },
    registrySize: Drawing.overlayRegistry.size,
    hoverCursor: _rectHoverCursor,
    chartElInlineCursor: chartEl.style.cursor,
    chartElComputedCursor: getComputedStyle(chartEl).cursor,
  });

  // Hover: show resize cursor when pointer is within 8px of any rect handle.
  // Capture phase so KLineChart's canvas (child) can't swallow the event.
  chartEl.addEventListener('mousemove', (e) => {
    if (_rectDrag || _overlayDrag) return;           // drag controls its own cursor
    if (Drawing.activeTool !== 'cross') {
      if (_rectHoverCursor) {
        chartEl.style.removeProperty('cursor');
        _rectHoverCursor = '';
      }
      return;
    }
    const rect = chartEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Wider-tolerance trendline hover — drives BOTH the "+ 新增文字" placeholder
    // AND the pointer cursor. KLineChart's own hit-test is too tight (~3 px).
    // Hover also counts when pointer is inside the text/placeholder box, so
    // large/offset labels remain clickable past the 12 px line tolerance.
    let nearestTrendId = null;
    let nearestDist = TRENDLINE_HOVER_TOL + 1;
    for (const entry of Drawing.overlayRegistry.values()) {
      if (entry.name !== 'trendline_snap') continue;
      if (entry.visible === false) continue;
      if (!entry.points || entry.points.length < 2) continue;
      try {
        const out = Drawing.chart.convertToPixel(
          [entry.points[0], entry.points[1]], { paneId: 'candle_pane' });
        if (!Array.isArray(out) || out.length < 2) continue;
        const d = _distToLineSegment(mx, my, out[0].x, out[0].y, out[1].x, out[1].y);
        if (d <= TRENDLINE_HOVER_TOL && d < nearestDist) {
          nearestDist = d;
          nearestTrendId = entry.id;
          continue;
        }
        // Still hovered if pointer is inside the label/placeholder box, even
        // if the line is > 12 px away.
        if (_clickOnTrendlineText(mx, my, entry)) {
          nearestDist = 0;
          nearestTrendId = entry.id;
        }
      } catch (err) { /* ignore */ }
    }
    if (nearestTrendId !== _trendlineHoverId) {
      const prev = _trendlineHoverId;
      _trendlineHoverId = nearestTrendId;
      if (prev) { try { Drawing.chart.overrideOverlay({ id: prev }); } catch (er) {} }
      if (nearestTrendId) { try { Drawing.chart.overrideOverlay({ id: nearestTrendId }); } catch (er) {} }
    }

    const hit = hitTestRectHandle(mx, my);
    const bodyEntry = hit ? null : hitTestRectBody(mx, my);
    // Priority: rect handle (resize) > rect body > trendline (pointer) > none.
    // A text box body shows the MOVE cursor (it's draggable); a plain rectangle
    // body shows pointer (not movable, only resizable via handles).
    let desired;
    if (hit) desired = cursorForRectHandle(hit.handle.idx);
    else if (bodyEntry) desired = (bodyEntry.extendData && bodyEntry.extendData.textBox) ? 'move' : 'pointer';
    else if (nearestTrendId) desired = 'pointer';
    else desired = '';
    if (desired !== _rectHoverCursor) {
      if (desired) {
        chartEl.style.setProperty('cursor', desired, 'important');
        chartEl.querySelectorAll('canvas').forEach(cv => {
          cv.style.setProperty('cursor', desired, 'important');
        });
      } else {
        chartEl.style.removeProperty('cursor');
        chartEl.querySelectorAll('canvas').forEach(cv => {
          cv.style.removeProperty('cursor');
        });
      }
      _rectHoverCursor = desired;
    }
  }, true);

  // Mini-chart hover cursor: resize arrows over a selected mini rect's handles,
  // pointer over a mini rect body. hitTestRectHandle is chart-aware (uses the
  // selected overlay's chart); hitTestRectBody is passed the mini chart.
  const _miniHoverEl = document.getElementById('mini-chart');
  if (_miniHoverEl) {
    _miniHoverEl.addEventListener('mousemove', (e) => {
      if (_rectDrag || _overlayDrag) return;
      const setCur = (desired) => {
        if (desired === _miniHoverCursor) return;
        if (desired) {
          _miniHoverEl.style.setProperty('cursor', desired, 'important');
          _miniHoverEl.querySelectorAll('canvas').forEach(cv => cv.style.setProperty('cursor', desired, 'important'));
        } else {
          _miniHoverEl.style.removeProperty('cursor');
          _miniHoverEl.querySelectorAll('canvas').forEach(cv => cv.style.removeProperty('cursor'));
        }
        _miniHoverCursor = desired;
      };
      if (Drawing.activeTool !== 'cross') { setCur(''); return; }
      const mc = window.MiniChart && window.MiniChart.chart;
      if (!mc) { setCur(''); return; }
      const rect = _miniHoverEl.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const hit = hitTestRectHandle(mx, my);
      const bodyEntry = hit ? null : hitTestRectBody(mx, my, mc);
      setCur(hit ? cursorForRectHandle(hit.handle.idx) : (bodyEntry ? 'pointer' : ''));
    }, true);
  }

  const _onRectHandleDown = (e, containerEl) => {
    if (e.button !== 0) return;
    if (Drawing.activeTool !== 'cross') return;    // only in selection mode
    const rect = containerEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = hitTestRectHandle(mx, my);
    if (!hit) {
      // Body drag → MOVE a text box (rectangles keep their resize-only behavior,
      // so this is gated on the textBox flag). Translates BOTH corners by the
      // same pixel delta = a pure move.
      const mchart = window.MiniChart && window.MiniChart.chart;
      const chart = (containerEl.id === 'mini-chart' && mchart) ? mchart : Drawing.chart;
      const isMini = chart !== Drawing.chart;
      const bodyEntry = hitTestRectBody(mx, my, chart);
      if (bodyEntry && bodyEntry.extendData && bodyEntry.extendData.textBox && !bodyEntry.lock) {
        const id = isMini ? bodyEntry._ovid : bodyEntry.id;
        let pts = isMini ? (chart.getOverlayById(id) || {}).points : bodyEntry.points;
        if (!pts || pts.length < 2) return;
        let startPx;
        try {
          startPx = chart.convertToPixel(
            [{ dataIndex: pts[0].dataIndex, value: pts[0].value },
             { dataIndex: pts[1].dataIndex, value: pts[1].value }], { paneId: 'candle_pane' });
        } catch (err) { return; }
        _rectDrag = {
          overlayId: id, moveMode: true, chart, isMini, containerEl,
          startMx: mx, startMy: my,
          startPointPx: startPx.map(p => ({ x: p.x, y: p.y })),
          beforePoints: pts.map(p => ({ ...p })),
        };
        // Select it now (we stopImmediatePropagation below, so KLineChart's own
        // onSelected won't fire) and repaint so the handles appear immediately.
        const prevSel = Drawing.selectedOverlay && Drawing.selectedOverlay.id;
        Drawing.selectedOverlay = chart.getOverlayById(id) || bodyEntry;
        if (prevSel && prevSel !== id) { try { _forceSelectRepaint(prevSel); } catch (er) {} }
        try { _forceSelectRepaint(id); } catch (er) {}
        markSelectedTreeRow(id);
        setGlobalCursor('grabbing');
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        return;
      }
      // Clicked empty space (or a non-text-box) while a TEXT BOX is selected →
      // deselect it. KLineChart's onDeselected doesn't fire for our manually-
      // selected text boxes, so the handles would otherwise never clear. Don't
      // stop propagation: a click on another overlay still selects it normally.
      const sel = Drawing.selectedOverlay;
      if (sel && sel.extendData && sel.extendData.textBox && _rectEditingId !== sel.id) {
        Drawing.selectedOverlay = null;
        try { _forceSelectRepaint(sel.id); } catch (er) {}
        markSelectedTreeRow(null);
      }
      return;
    }
    const p1 = hit.points[0], p2 = hit.points[1];
    // Pin xPointIdx / yPointIdx ONCE at drag start. During the whole drag
    // we always mutate the same stored point(s) — this gives the
    // TradingView-style mirror: dragging R past L flips the rect and the
    // handle visually moves to the new edge.
    const leftIdx   = (p1.dataIndex ?? 0) <= (p2.dataIndex ?? 0) ? 0 : 1;
    const rightIdx  = leftIdx === 0 ? 1 : 0;
    const topIdx    = (p1.value ?? 0) >= (p2.value ?? 0) ? 0 : 1;
    const bottomIdx = topIdx === 0 ? 1 : 0;
    let xPointIdx = null, yPointIdx = null;
    switch (hit.handle.idx) {
      case 1: xPointIdx = leftIdx;  yPointIdx = topIdx;    break;  // TL
      case 2: xPointIdx = rightIdx; yPointIdx = topIdx;    break;  // TR
      case 3: xPointIdx = leftIdx;  yPointIdx = bottomIdx; break;  // BL
      case 4: xPointIdx = rightIdx; yPointIdx = bottomIdx; break;  // BR
      case 5: yPointIdx = topIdx;    break;                        // T
      case 6: yPointIdx = bottomIdx; break;                        // B
      case 7: xPointIdx = leftIdx;   break;                        // L
      case 8: xPointIdx = rightIdx;  break;                        // R
    }
    _rectDrag = { overlayId: hit.overlayId, handleIdx: hit.handle.idx, xPointIdx, yPointIdx,
                  chart: hit.chart, isMini: hit.isMini, containerEl };
    // Snapshot points for undo (hit.points already has dataIndex from the
    // right chart's overlay). Deep copy — mousemove mutates in place.
    _rectDrag.beforePoints = (hit.points || []).map(p => ({ ...p }));
    // Auto-select the rect we're about to drag. We have to set selectedOverlay
    // directly because our capture-phase stopImmediatePropagation() prevents
    // KLineChart from firing its own onSelected handler.
    if (!hit.isSel) Drawing.selectedOverlay = hit.entry;
    // Grabbing cursor while actively resizing (hover shows resize arrow; the
    // moment drag starts we switch to grabbing so the user has clear feedback
    // the shape is being manipulated).
    setGlobalCursor('grabbing');
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  chartEl.addEventListener('mousedown', (e) => _onRectHandleDown(e, chartEl), true);
  const _miniElForRect = document.getElementById('mini-chart');
  if (_miniElForRect) _miniElForRect.addEventListener('mousedown', (e) => _onRectHandleDown(e, _miniElForRect), true);

  window.addEventListener('mousemove', (e) => {
    if (!_rectDrag) return;
    const dChart = _rectDrag.chart || Drawing.chart;
    const dEl = _rectDrag.containerEl || chartEl;
    // Current points live on the chart overlay (mini) or the registry (main).
    let curPoints = null;
    if (_rectDrag.isMini) {
      const ov = dChart.getOverlayById && dChart.getOverlayById(_rectDrag.overlayId);
      curPoints = ov && ov.points;
    } else {
      const entry = Drawing.overlayRegistry.get(_rectDrag.overlayId);
      curPoints = entry && entry.points;
    }
    if (!curPoints || curPoints.length < 2) return;
    const chartElRect = dEl.getBoundingClientRect();
    const mx = e.clientX - chartElRect.left;
    const my = e.clientY - chartElRect.top;

    // Move mode (text box body drag): shift both corners by the pixel delta.
    if (_rectDrag.moveMode) {
      const dx = mx - _rectDrag.startMx, dy = my - _rectDrag.startMy;
      const movePts = _rectDrag.beforePoints.map((p, i) => {
        let out;
        try { out = dChart.convertFromPixel({ x: _rectDrag.startPointPx[i].x + dx, y: _rectDrag.startPointPx[i].y + dy }, { paneId: 'candle_pane' }); }
        catch (err) { return { ...p }; }
        const cc = Array.isArray(out) ? out[0] : out;
        if (!cc || !Number.isFinite(cc.value)) return { ...p };
        const o = { value: cc.value };
        if (Number.isFinite(cc.timestamp)) o.timestamp = cc.timestamp;
        if (Number.isFinite(cc.dataIndex)) o.dataIndex = cc.dataIndex;
        return o;
      });
      try { dChart.overrideOverlay({ id: _rectDrag.overlayId, points: movePts }); } catch (err) {}
      if (_rectDrag.isMini) {
        if (Drawing._miniRegistry) for (const en of Drawing._miniRegistry.values())
          if (en._ovid === _rectDrag.overlayId) { en.points = movePts.map(p => ({ timestamp: p.timestamp, value: p.value })); break; }
      } else {
        const entry = Drawing.overlayRegistry.get(_rectDrag.overlayId);
        if (entry) entry.points = movePts;
      }
      if (_rectEditingId === _rectDrag.overlayId) repositionRectEditor();
      e.preventDefault(); e.stopPropagation();
      return;
    }

    let pt = null;
    try {
      const out = dChart.convertFromPixel({ x: mx, y: my }, { paneId: 'candle_pane' });
      pt = Array.isArray(out) ? out[0] : out;
    } catch (err) { return; }
    if (!pt) return;

    const newPts = curPoints.map(p => ({ ...p }));
    if (_rectDrag.xPointIdx != null) {
      newPts[_rectDrag.xPointIdx].dataIndex = pt.dataIndex;
      newPts[_rectDrag.xPointIdx].timestamp = pt.timestamp;
    }
    if (_rectDrag.yPointIdx != null) {
      newPts[_rectDrag.yPointIdx].value = pt.value;
    }
    try {
      dChart.overrideOverlay({ id: _rectDrag.overlayId, points: newPts });
    } catch (err) { /* ignore */ }
    // Sync to the right registry.
    if (_rectDrag.isMini) {
      if (Drawing._miniRegistry) for (const en of Drawing._miniRegistry.values()) {
        if (en._ovid === _rectDrag.overlayId) { en.points = newPts.map(p => ({ timestamp: p.timestamp, value: p.value })); break; }
      }
    } else {
      const entry = Drawing.overlayRegistry.get(_rectDrag.overlayId);
      if (entry) entry.points = newPts;
    }
    // If this rect is in inline-edit mode, keep the textarea aligned with the
    // moving rect so the user's in-progress text doesn't "fly away".
    if (_rectEditingId === _rectDrag.overlayId) repositionRectEditor();
    e.preventDefault();
    e.stopPropagation();
  }, true);

  window.addEventListener('mouseup', () => {
    if (_rectDrag) {
      // Undo entry — drag was a single logical operation. Skip if
      // points didn't actually change (user clicked a handle without
      // dragging). chart-aware: mini rects read/write via the mini chart
      // + _miniRegistry.
      const id = _rectDrag.overlayId;
      const dChart = _rectDrag.chart || Drawing.chart;
      const isMini = !!_rectDrag.isMini;
      let afterSrc;
      if (isMini) { const ov = dChart.getOverlayById && dChart.getOverlayById(id); afterSrc = ov && ov.points; }
      else { const entry = Drawing.overlayRegistry.get(id); afterSrc = entry && entry.points; }
      const before = _rectDrag.beforePoints || [];
      const after  = afterSrc ? afterSrc.map(p => ({ ...p })) : [];
      const sameAsBefore = before.length === after.length
        && before.every((p, i) =>
            p.timestamp === after[i].timestamp && p.value === after[i].value);
      if (!sameAsBefore && before.length && after.length) {
        const ptsFor = (pts) => isMini ? _pointsForMini(dChart, pts) : _pointsForChart(pts);
        const syncReg = (pts) => {
          if (isMini) { if (Drawing._miniRegistry) for (const en of Drawing._miniRegistry.values()) { if (en._ovid === id) { en.points = pts.map(p => ({ timestamp: p.timestamp, value: p.value })); break; } } }
          else { const e2 = Drawing.overlayRegistry.get(id); if (e2) e2.points = pts.map(p => ({ ...p })); }
        };
        pushUndo({
          label: _rectDrag.moveMode ? 'Move text box' : 'Resize rectangle',
          undo: () => { try { dChart.overrideOverlay({ id, points: ptsFor(before) }); } catch (e) {} syncReg(before); },
          redo: () => { try { dChart.overrideOverlay({ id, points: ptsFor(after) }); } catch (e) {} syncReg(after); },
        });
      }
      _rectDrag = null;
      setGlobalCursor('');
      // Force next hover mousemove to re-evaluate (so resize cursor re-appears
      // if the pointer is still on a handle).
      _rectHoverCursor = '';
      // Save the new position/size.
      schedulePersist();
    }
  }, true);

  // ---- Inline text edit: click an already-selected rect body (not a handle)
  //      to open an overlay textarea positioned over the rect.
  let _preClickSelectedId = null;
  chartEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || Drawing.activeTool !== 'cross') {
      _preClickSelectedId = null; return;
    }
    _preClickSelectedId = Drawing.selectedOverlay && Drawing.selectedOverlay.id;
  }, true);
  chartEl.addEventListener('click', (e) => {
    if (_rectDrag || _overlayDrag) return;
    const rect = chartEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (hitTestRectHandle(mx, my)) return;

    // Rect body → rect inline edit (same two-step pattern)
    const bodyEntry = hitTestRectBody(mx, my);
    if (bodyEntry) {
      if (_preClickSelectedId !== bodyEntry.id) return;
      if (bodyEntry.lock) return;
      startRectTextEdit(bodyEntry);
      return;
    }

    // Trendline → use wide 12px zone for SELECT. For edit, the click must
    // land inside the text or "+ 新增文字" placeholder box (not any point on
    // the line), so the user can click the line without accidentally opening
    // the editor.
    if (_trendlineHoverId) {
      const trend = Drawing.overlayRegistry.get(_trendlineHoverId);
      if (!trend || trend.lock) return;
      const alreadySelected = _preClickSelectedId === trend.id;
      const onTextBox = _clickOnTrendlineText(mx, my, trend);
      if (alreadySelected && onTextBox) {
        startTrendlineTextEdit(trend);
      } else if (!alreadySelected) {
        Drawing.selectedOverlay = trend;
        try { Drawing.chart.overrideOverlay({ id: trend.id }); } catch (err) {}
      }
      // else: already selected but clicked elsewhere on line → no-op
    }
  });

  // Text box: DOUBLE-click the body to edit (single-click selects / arms move,
  // so the rectangle's single-click-to-edit doesn't apply). Main chart only —
  // mini text editing isn't wired yet.
  chartEl.addEventListener('dblclick', (e) => {
    if (Drawing.activeTool !== 'cross') return;
    const rect = chartEl.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const bodyEntry = hitTestRectBody(mx, my, Drawing.chart);
    if (bodyEntry && bodyEntry.extendData && bodyEntry.extendData.textBox && !bodyEntry.lock) {
      e.preventDefault(); e.stopPropagation();
      Drawing.selectedOverlay = Drawing.chart.getOverlayById(bodyEntry.id) || bodyEntry;
      startRectTextEdit(bodyEntry);
    }
  }, true);
}

// =================================================================
// Inline text editor for rectangle labels
// =================================================================
// Pixel extent a text box needs to fit `textState`. wrap=false → width = the
// widest explicit line (auto-grow, no wrapping). wrap=true → width is clamped to
// fixedWidthPx and lines soft-wrap; height grows with the wrapped count. Returns
// { w, h } in pixels including 4px padding on every side. Top-level (not inside
// registerOverlays) so _autoSizeTextBox can call it.
function measureTextBoxPixels(textState, wrap, fixedWidthPx) {
  const t = { ...DEFAULT_TEXT_STATE, ...(textState || {}) };
  const pad = 4;
  const weight = t.bold ? 900 : 400;
  const ctx = _textMeasureCtx();
  ctx.font = `${t.italic ? 'italic ' : ''}${weight} ${t.size}px "Noto Sans SC", sans-serif`;
  const lineHeight = Math.ceil(t.size * 1.2);
  const paras = (t.content || '').split(/\r?\n/);
  let lines = [];
  if (wrap) {
    const inner = Math.max(8, (fixedWidthPx || 160) - 2 * pad);
    for (const p of paras) lines.push(...(p ? wrapLine(ctx, p, inner) : ['']));
  } else {
    lines = paras;
  }
  let maxW = 0;
  for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln || '').width);
  const w = wrap ? (fixedWidthPx || 160) : Math.ceil(maxW) + 2 * pad;
  const h = Math.max(1, lines.length) * lineHeight + 2 * pad;
  return { w: Math.max(24, w), h: Math.max(lineHeight + 2 * pad, h) };
}

// Resize a text box to fit its text after an edit. Keeps the visual TOP-LEFT
// corner fixed; grows right/down. No-wrap → width = widest line. Wrap → width is
// kept, height grows with the wrapped line count. Rectangles (no textBox flag)
// are left alone.
function _autoSizeTextBox(entry) {
  if (!entry || !entry.extendData || !entry.extendData.textBox) return;
  if (!entry.points || entry.points.length < 2) return;
  const chart = _chartOf(entry.id);
  if (!chart) return;
  const handles = computeRectHandlePixels(entry.points[0], entry.points[1], chart);
  if (!handles) return;
  const xL = handles[0].x, yT = handles[0].y;                 // TL corner (visual)
  const xR = handles[3].x;
  const wrap = !!entry.extendData.wrap;
  const { w, h } = measureTextBoxPixels(entry.extendData.text, wrap, Math.abs(xR - xL));
  let br;
  try { br = chart.convertFromPixel({ x: xL + w, y: yT + h }, { paneId: 'candle_pane' }); }
  catch (e) { return; }
  const b = Array.isArray(br) ? br[0] : br;
  const tl2 = chart.convertFromPixel({ x: xL, y: yT }, { paneId: 'candle_pane' });
  const a = Array.isArray(tl2) ? tl2[0] : tl2;
  if (!a || !b || !Number.isFinite(a.value) || !Number.isFinite(b.value)) return;
  const mk = (p, ref) => {
    const o = { value: p.value };
    if (Number.isFinite(p.timestamp)) o.timestamp = p.timestamp;
    if (Number.isFinite(p.dataIndex)) o.dataIndex = p.dataIndex;
    return o;
  };
  const newPts = [mk(a), mk(b)];
  try { chart.overrideOverlay({ id: entry.id, points: newPts }); } catch (e) { return; }
  // Keep the registry (main or mini) canonical points in sync.
  const reg = Drawing.overlayRegistry.get(entry.id);
  if (reg) reg.points = newPts;
  else if (Drawing._miniRegistry) for (const e of Drawing._miniRegistry.values())
    if (e._ovid === entry.id) { e.points = newPts.map(p => ({ timestamp: p.timestamp, value: p.value })); break; }
  schedulePersist();
}

function startRectTextEdit(entry) {
  if (!entry || _rectEditingId === entry.id) return;
  if (!entry.points || entry.points.length < 2) return;
  const chartEl = document.getElementById('chart');
  const px = computeRectHandlePixels(entry.points[0], entry.points[1]);
  if (!px) return;
  const xL = Math.min(px[0].x, px[3].x);
  const xR = Math.max(px[0].x, px[3].x);
  const yT = Math.min(px[0].y, px[3].y);
  const yB = Math.max(px[0].y, px[3].y);

  const cur = (entry.extendData && entry.extendData.text) || {};
  const t = { ...DEFAULT_TEXT_STATE, ...cur };
  const isTB = !!(entry.extendData && entry.extendData.textBox);
  const tbWrap = isTB && !!entry.extendData.wrap;
  // Top-left anchor stays fixed while a text box grows right/down as you type.
  const anchorXL = xL, anchorYT = yT;
  const PAD = 4;             // must match buildRectTextFigures / measureTextBoxPixels

  const chartRect = chartEl.getBoundingClientRect();
  // Container spans the rect bounds and uses flex to place the textarea at
  // the same spot where the rendered label would appear (vPos × hAlign).
  const host = document.createElement('div');
  Object.assign(host.style, {
    position: 'fixed',
    left:   (chartRect.left + xL) + 'px',
    top:    (chartRect.top  + yT) + 'px',
    width:  (xR - xL) + 'px',
    height: (yB - yT) + 'px',
    // A text box anchors its text top-left with 4px padding (matching the
    // rendered label) and grows to fit; a rectangle label flex-centers per
    // vPos × hAlign inside the fixed box.
    display: 'flex',
    padding: isTB ? PAD + 'px' : '0',
    alignItems: isTB ? 'flex-start' : (
      t.vPos === 'top'    ? 'flex-start' :
      t.vPos === 'bottom' ? 'flex-end'   : 'center'),
    justifyContent: isTB ? 'flex-start' : (
      t.hAlign === 'left'  ? 'flex-start' :
      t.hAlign === 'right' ? 'flex-end'   : 'center'),
    boxSizing: 'border-box',
    pointerEvents: 'none',   // clicks pass through to textarea / chart
    zIndex: 9999,
  });
  const ta = document.createElement('textarea');
  ta.className = 'rect-inline-editor';
  ta.rows = 1;              // default is 2 → makes scrollHeight=2*lineHeight even when empty
  // No-wrap text box → the textarea must not soft-wrap either (it grows wider
  // and the box follows). Wrapping box / rectangle label → soft wrap.
  ta.wrap = (isTB && !tbWrap) ? 'off' : 'soft';
  ta.value = t.content || '';
  ta.placeholder = (window.I18n && window.I18n.t)
    ? window.I18n.t('tool.addTextEditing') : '新增文字';
  Object.assign(ta.style, {
    fontFamily:  '"Noto Sans SC", sans-serif',
    fontSize:    t.size + 'px',
    fontWeight:  t.bold ? 900 : 400,
    fontStyle:   t.italic ? 'italic' : 'normal',
    color:       hexToRgba(t.color.hex, t.color.opacity),
    textAlign:   isTB ? 'left' : t.hAlign,
    background:  'transparent',
    border:      'none',
    outline:     'none',
    resize:      'none',
    padding:     '0',
    margin:      '0',
    boxSizing:   'border-box',
    lineHeight:  '1.2',
    width:       '100%',
    height:      '100%',
    maxHeight:   isTB ? 'none' : '100%',
    whiteSpace:  (isTB && !tbWrap) ? 'pre' : 'pre-wrap',
    overflow:    'hidden',
    pointerEvents: 'auto',
  });
  host.appendChild(ta);
  document.body.appendChild(host);
  _rectEditHost = host;
  const placeholderText = ta.placeholder;
  // Rectangle label: grow textarea height inside the fixed box.
  // Text box: resize the OVERLAY (and this host) to fit the text live, keeping
  // the top-left corner fixed — so the box, its handles and the caret all track
  // the text as you type (no empty right-hand gap, no overflow past the box).
  const mkPt = (p) => { const o = { value: p.value };
    if (Number.isFinite(p.timestamp)) o.timestamp = p.timestamp;
    if (Number.isFinite(p.dataIndex)) o.dataIndex = p.dataIndex; return o; };
  const autosize = () => {
    if (!isTB) {
      ta.style.height = '0';
      ta.style.height = Math.min(ta.scrollHeight, yB - yT) + 'px';
      return;
    }
    const content = ta.value || '';
    const fixedW = tbWrap ? (xR - xL) : undefined;
    const { w, h } = measureTextBoxPixels({ ...t, content: content || placeholderText }, tbWrap, fixedW);
    host.style.width = w + 'px';
    host.style.height = h + 'px';
    const ch = _chartOf(entry.id);
    let a, b;
    try {
      a = ch.convertFromPixel({ x: anchorXL, y: anchorYT }, { paneId: 'candle_pane' });
      b = ch.convertFromPixel({ x: anchorXL + w, y: anchorYT + h }, { paneId: 'candle_pane' });
    } catch (e) { return; }
    const pa = Array.isArray(a) ? a[0] : a, pb = Array.isArray(b) ? b[0] : b;
    if (!pa || !pb || !Number.isFinite(pa.value) || !Number.isFinite(pb.value)) return;
    const pts = [mkPt(pa), mkPt(pb)];
    try { ch.overrideOverlay({ id: entry.id, points: pts }); } catch (e) {}
    const reg = Drawing.overlayRegistry.get(entry.id);
    if (reg) reg.points = pts;
    else if (Drawing._miniRegistry) for (const me of Drawing._miniRegistry.values())
      if (me._ovid === entry.id) { me.points = pts.map(p => ({ timestamp: p.timestamp, value: p.value })); break; }
  };
  ta.addEventListener('input', autosize);
  autosize();
  _rectEditingId = entry.id;
  // Trigger a redraw so the ghost placeholder disappears while editing.
  try { Drawing.chart.overrideOverlay({ id: entry.id, extendData: entry.extendData || {} }); }
  catch (e) { /* ignore */ }

  ta.focus();
  // Cursor at end (not select-all) so first keystroke appends instead of
  // wiping existing text.
  const endPos = ta.value.length;
  ta.setSelectionRange(endPos, endPos);

  let done = false;
  const beforeContent = t.content || '';
  const commit = () => {
    if (done) return; done = true;
    const newContent = ta.value;
    host.remove();
    _rectEditingId = null;
    _rectEditHost = null;
    // An empty text box is discarded — clicking away from a blank box (or never
    // typing anything) removes it, like PowerPoint. This is NOT recorded on the
    // undo stack: it never had content, so there's nothing to restore.
    if (isTB && !newContent.trim()) {
      try { _chartOf(entry.id).removeOverlay({ id: entry.id }); } catch (e) {}
      untrackOverlay(entry.id);
      if (Drawing.selectedOverlay && Drawing.selectedOverlay.id === entry.id) Drawing.selectedOverlay = null;
      refreshObjectTree();
      schedulePersist();
      return;
    }
    const newText = { ...t, content: newContent };
    const extendData = { ...(entry.extendData || {}), text: newText };
    try { _chartOf(entry.id).overrideOverlay({ id: entry.id, extendData }); }
    catch (e) { /* ignore */ }
    entry.extendData = extendData;
    // Text box grows/shrinks to fit; rectangles keep their drawn size.
    if (extendData.textBox) _autoSizeTextBox(Drawing.overlayRegistry.get(entry.id) || entry);
    // If the settings panel is open on this same rect, sync the textarea.
    if (SP.panel && !SP.panel.classList.contains('hidden')
        && Drawing.selectedOverlay && Drawing.selectedOverlay.id === entry.id) {
      loadTextIntoPanel(newText);
    }
    // Undo: revert content to the value the editor opened with.
    if (newContent !== beforeContent) {
      const id = entry.id;
      const beforeText = { ...t, content: beforeContent };
      const beforeExt  = { ...(entry.extendData || {}), text: beforeText };
      // entry.extendData has been mutated to the new state — keep
      // a frozen copy for redo.
      const afterExt = JSON.parse(JSON.stringify(extendData));
      pushUndo({
        label: 'Edit rectangle text',
        undo: () => {
          try { Drawing.chart.overrideOverlay({ id, extendData: beforeExt }); } catch (e) {}
          const e2 = Drawing.overlayRegistry.get(id);
          if (e2) e2.extendData = beforeExt;
        },
        redo: () => {
          try { Drawing.chart.overrideOverlay({ id, extendData: afterExt }); } catch (e) {}
          const e2 = Drawing.overlayRegistry.get(id);
          if (e2) e2.extendData = afterExt;
        },
      });
    }
  };
  const cancel = () => {
    if (done) return; done = true;
    host.remove();
    _rectEditingId = null;
    _rectEditHost = null;
    // Esc on a text box that had no text to begin with → discard it (same as a
    // blank commit). A text box that already HAS text just reverts the display.
    if (isTB && !beforeContent.trim()) {
      try { _chartOf(entry.id).removeOverlay({ id: entry.id }); } catch (e) {}
      untrackOverlay(entry.id);
      if (Drawing.selectedOverlay && Drawing.selectedOverlay.id === entry.id) Drawing.selectedOverlay = null;
      refreshObjectTree();
      schedulePersist();
      return;
    }
    try { _chartOf(entry.id).overrideOverlay({ id: entry.id, extendData: entry.extendData || {} }); }
    catch (e) { /* ignore */ }
  };

  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();   // keep global Del/Ctrl+C etc. from firing while typing
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    // Text box: Enter inserts a newline (PowerPoint-style); commit by clicking
    // away. Rectangle/trendline label: Enter commits, Shift+Enter newlines.
    else if (!isTB && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
  });
}

// =================================================================
// Inline text editor for trendline labels — textarea rotated to match slope
// =================================================================
function startTrendlineTextEdit(entry) {
  if (!entry || _trendEditingId === entry.id) return;
  if (!entry.points || entry.points.length < 2) return;
  const chartEl = document.getElementById('chart');
  let out;
  try {
    out = Drawing.chart.convertToPixel(
      [entry.points[0], entry.points[1]], { paneId: 'candle_pane' });
  } catch (e) { return; }
  if (!Array.isArray(out) || out.length < 2) return;
  // Always left-to-right so rotation stays in [-π/2, π/2] (no upside-down text).
  const pL = out[0].x <= out[1].x ? out[0] : out[1];
  const pR = out[0].x <= out[1].x ? out[1] : out[0];
  const dx = pR.x - pL.x, dy = pR.y - pL.y;
  const len = Math.hypot(dx, dy);
  if (len < 20) return;
  const angleRad = Math.atan2(dy, dx);
  const midX = (pL.x + pR.x) / 2;
  const midY = (pL.y + pR.y) / 2;

  const cur = (entry.extendData && entry.extendData.text) || {};
  const t = { ...DEFAULT_TEXT_STATE, ...cur };

  const chartRect = chartEl.getBoundingClientRect();
  const taWidth = Math.max(len - 16, 120);
  const taHeight = Math.ceil(t.size * 1.4);   // 1.2 line + a bit of breathing room

  const ta = document.createElement('textarea');
  ta.className = 'trendline-inline-editor';
  ta.rows = 1;
  ta.value = t.content || '';
  ta.placeholder = (window.I18n && window.I18n.t)
    ? window.I18n.t('tool.addTextEditing') : '新增文字';
  Object.assign(ta.style, {
    position:    'fixed',
    left:        (chartRect.left + midX - taWidth / 2) + 'px',
    top:         (chartRect.top  + midY - taHeight / 2) + 'px',
    width:       taWidth + 'px',
    height:      taHeight + 'px',
    transform:   `rotate(${angleRad}rad)`,
    transformOrigin: 'center',
    fontFamily:  '"Noto Sans SC", sans-serif',
    fontSize:    t.size + 'px',
    fontWeight:  t.bold ? 900 : 400,
    fontStyle:   t.italic ? 'italic' : 'normal',
    color:       hexToRgba(t.color.hex, t.color.opacity),
    textAlign:   t.hAlign,
    background:  'transparent',
    border:      'none',
    outline:     'none',
    resize:      'none',
    padding:     '0',
    margin:      '0',
    lineHeight:  '1.2',
    overflow:    'hidden',
    zIndex:      9999,
  });
  document.body.appendChild(ta);
  _trendEditingId = entry.id;
  _trendEditingState = { ...t, content: ta.value };
  try { Drawing.chart.overrideOverlay({ id: entry.id, extendData: entry.extendData || {} }); }
  catch (e) { /* ignore */ }

  ta.focus();
  // Put cursor at end so user can edit naturally (not select-all, which would
  // accidentally replace existing text on the first keystroke).
  const endPos = ta.value.length;
  ta.setSelectionRange(endPos, endPos);

  // Live-update the line break as user types.
  ta.addEventListener('input', () => {
    if (_trendEditingState) _trendEditingState.content = ta.value;
    try { Drawing.chart.overrideOverlay({ id: entry.id, extendData: entry.extendData || {} }); }
    catch (e) { /* ignore */ }
  });

  let done = false;
  const beforeContent = t.content || '';
  const commit = () => {
    if (done) return; done = true;
    const newContent = ta.value;
    ta.remove();
    _trendEditingId = null;
    _trendEditingState = null;
    const newText = { ...t, content: newContent };
    const extendData = { ...(entry.extendData || {}), text: newText };
    try { Drawing.chart.overrideOverlay({ id: entry.id, extendData }); } catch (e) {}
    entry.extendData = extendData;
    if (SP.panel && !SP.panel.classList.contains('hidden')
        && Drawing.selectedOverlay && Drawing.selectedOverlay.id === entry.id) {
      loadTextIntoPanel(newText);
    }
    if (newContent !== beforeContent) {
      const id = entry.id;
      const beforeText = { ...t, content: beforeContent };
      const beforeExt  = { ...(entry.extendData || {}), text: beforeText };
      const afterExt   = JSON.parse(JSON.stringify(extendData));
      pushUndo({
        label: 'Edit trendline text',
        undo: () => {
          try { Drawing.chart.overrideOverlay({ id, extendData: beforeExt }); } catch (e) {}
          const e2 = Drawing.overlayRegistry.get(id);
          if (e2) e2.extendData = beforeExt;
        },
        redo: () => {
          try { Drawing.chart.overrideOverlay({ id, extendData: afterExt }); } catch (e) {}
          const e2 = Drawing.overlayRegistry.get(id);
          if (e2) e2.extendData = afterExt;
        },
      });
    }
  };
  const cancel = () => {
    if (done) return; done = true;
    ta.remove();
    _trendEditingId = null;
    _trendEditingState = null;
    try { Drawing.chart.overrideOverlay({ id: entry.id, extendData: entry.extendData || {} }); }
    catch (e) { /* ignore */ }
  };

  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
    else if (e.key === 'Escape')          { e.preventDefault(); cancel(); }
  });
}

// =================================================================
// Context menu
// =================================================================
function initContextMenu() {
  const menu = document.getElementById('ctx-menu');
  if (!menu) return;

  menu.querySelectorAll('.ctx-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.classList.contains('disabled')) return;
      const act = item.dataset.act;
      switch (act) {
        case 'clone':       cloneSelected(); break;
        case 'copy':        copySelected(); break;
        case 'cut':         cutSelected(); break;
        case 'paste':       pasteAtCrosshair(); break;
        case 'zorder-top':  setZOrder(true); break;
        case 'zorder-bottom': setZOrder(false); break;
        case 'lock':        toggleLock(); break;
        case 'hide':        toggleVisible(); break;
        case 'remove':      removeSelected(); break;
        case 'settings':    showSettings(Drawing.selectedOverlay, getOverlayDisplayName(Drawing.selectedOverlay)); break;
        case 'continue-path': continueSelectedPath(); break;
        case 'set-target-rr': RrPopup.open(Drawing.selectedOverlay, 'target'); break;
        case 'set-stop-rr':   RrPopup.open(Drawing.selectedOverlay, 'stop');   break;
      }
      hideContextMenu();
    });
  });

  // Close on outside click / Esc / scroll
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) hideContextMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });
  window.addEventListener('blur', hideContextMenu);

  // R:R input popup — capture-phase keydown (beats app.js's tf-popup handler)
  // + click-outside cancel, mirroring the tf-popup wiring.
  document.addEventListener('keydown', (e) => RrPopup.handleKey(e), true);
  document.addEventListener('mousedown', (e) => {
    const pop = document.getElementById('rr-popup');
    if (!pop || pop.classList.contains('hidden')) return;
    if (pop.contains(e.target)) return;
    RrPopup.hide();
  }, true);
  window.addEventListener('resize', hideContextMenu);
}

function showContextMenu(pageX, pageY) {
  const menu = document.getElementById('ctx-menu');
  if (!menu) return;
  menu.classList.remove('hidden');
  refreshContextMenuLabels();
  // Clamp to viewport
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const x = Math.min(pageX, window.innerWidth - w - 5);
  const y = Math.min(pageY, window.innerHeight - h - 5);
  menu.style.left = Math.max(0, x) + 'px';
  menu.style.top = Math.max(0, y) + 'px';
}

function hideContextMenu() {
  const menu = document.getElementById('ctx-menu');
  if (menu) menu.classList.add('hidden');
}

// =================================================================
// Undo / Redo manager
//
// Per-operation entries: { label, undo: fn, redo: fn }. The mutation
// site is responsible for capturing before-state, performing the
// mutation, then pushing the entry. Each entry's closures restore /
// reapply the captured state.
//
// Stack is capped at UNDO_CAP; oldest entries get evicted. A new
// action clears the redo stack (standard semantics — once you do
// something fresh after an undo, the redo branch is dead).
//
// Hook coverage (per user spec):
//   - Delete           (removeSelected / clearAll)
//   - Move / drag      (KLineChart pressedMove + rect handle drag)
//   - Edit text        (rect + trendline inline editors)
//   - Style change     (drawing settings panel commit)
//   - Chart settings   (商品 K-bar colors / bg / lang via 確認)
//
// Skipped intentionally:
//   - Create overlay (most users don't want their just-drawn shape
//     yanked away by Ctrl+Z; can be added later if asked)
//
// Keybindings: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Y = redo,
//              Ctrl/Cmd+Shift+Z = redo (Mac convention).
//   Skipped while the focus is in INPUT/TEXTAREA/SELECT or a
//   contentEditable region — those have native text-undo we don't
//   want to fight.
// =================================================================
const _undoStack = [];
const _redoStack = [];
const UNDO_CAP = 100;

function pushUndo(action) {
  if (!action || typeof action.undo !== 'function' || typeof action.redo !== 'function') return;
  _undoStack.push(action);
  if (_undoStack.length > UNDO_CAP) _undoStack.shift();
  _redoStack.length = 0;
}

function performUndo() {
  if (!_undoStack.length) return;
  const action = _undoStack.pop();
  try { action.undo(); }
  catch (e) { console.warn('[undo] failed', action.label, e); return; }
  _redoStack.push(action);
}

function performRedo() {
  if (!_redoStack.length) return;
  const action = _redoStack.pop();
  try { action.redo(); }
  catch (e) { console.warn('[redo] failed', action.label, e); return; }
  _undoStack.push(action);
}

function clearUndoHistory() {
  _undoStack.length = 0;
  _redoStack.length = 0;
}

function _initUndoKeybindings() {
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const target = e.target;
    const tag = (target && target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (target && target.isContentEditable) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'z' && !e.shiftKey) { performUndo(); e.preventDefault(); }
    else if (k === 'z' &&  e.shiftKey) { performRedo(); e.preventDefault(); }
    else if (k === 'y') { performRedo(); e.preventDefault(); }
  }, true);
}

/** Full reconstructable snapshot of an overlay — points (canonical
 *  timestamps), styles, extendData, lock, visible. Used by the
 *  delete-undo path to recreate after a removal. */
function _fullOverlaySnapshot(ov) {
  if (!ov) return null;
  const bars = (window.App && window.App.currentBars) || [];
  // Which chart the overlay lived on (+ its branch + registry entry) so undo
  // recreates it THERE, not on the main chart.
  const miniChart = window.MiniChart && window.MiniChart.chart;
  const onMini = !!(miniChart && _chartOf(ov.id) === miniChart);
  let branchId = null, miniEntry = null;
  if (onMini && Drawing._miniRegistry) {
    for (const e of Drawing._miniRegistry.values()) { if (e._ovid === ov.id) { branchId = e.branchId; miniEntry = e; break; } }
  }
  // For a mini overlay use the registry's canonical timestamp+value points —
  // the chart overlay's dataIndex is relative to the MINI's bars, so reading
  // the timestamp back through the MAIN bars distorts the shape.
  const points = (onMini && miniEntry && miniEntry.points)
    ? miniEntry.points.map(p => ({ timestamp: p.timestamp, value: p.value }))
    : (ov.points || []).map(p => {
        const out = { value: p.value };
        const ts = timestampFromPoint(p, bars);
        if (Number.isFinite(ts)) out.timestamp = ts;
        return out;
      });
  return {
    name: ov.name === 'path_snap' ? 'path_done' : ov.name,
    points,
    styles: ov.styles ? JSON.parse(JSON.stringify(ov.styles)) : undefined,
    extendData: ov.extendData ? JSON.parse(JSON.stringify(ov.extendData)) : undefined,
    lock: !!ov.lock,
    visible: ov.visible !== false,
    host: onMini ? 'mini' : 'main',
    branchId,
  };
}

/** Recreate an overlay from a snapshot returned by _fullOverlaySnapshot.
 *  Returns the new overlay id (KLineChart assigns a fresh one — old id
 *  isn't reusable). Caller pushes the new id back into the action's
 *  mutable holder so subsequent redo can target it. */
function _recreateFromSnapshot(snap) {
  if (!snap) return null;
  // Mini-hosted overlay: recreate on the mini chart + _miniRegistry (never on
  // main). If the mini is closed we can't restore it visually — bail rather
  // than leak it onto the main chart.
  if (snap.host === 'mini') {
    const miniChart = window.MiniChart && window.MiniChart.chart;
    if (!miniChart) return null;
    // Pass canonical {timestamp,value} ONLY — NO explicit dataIndex — exactly
    // like the main recreate below (_pointsForChart). KLineChart treats a
    // supplied dataIndex as authoritative and SNAPS the point's value to that
    // bar, so recreating a delete+undo with an idxByTs dataIndex rewrote the
    // drawn Y (a free convertFromPixel value) onto the bar — the mini "刪除復原
    // 位置跑掉" bug (confirmed live: canonical [29628.66,29496.47] came back from
    // createOverlay-with-dataIndex as [29600.25,29482.75] at +0ms). Letting
    // KLineChart derive the index from the timestamp keeps the drawn value.
    const opts = { name: snap.name, points: _pointsForChart(snap.points) };
    if (snap.styles)     opts.styles     = snap.styles;
    if (snap.extendData) opts.extendData = snap.extendData;
    if (snap.lock)       opts.lock       = true;
    if (snap.visible === false) opts.visible = false;
    let newId;
    try { newId = miniChart.createOverlay(opts); } catch (e) { return null; }
    if (typeof newId !== 'string') return null;
    if (!Drawing._miniRegistry) Drawing._miniRegistry = new Map();
    const key = 'm' + (Drawing._miniSeq = (Drawing._miniSeq || 0) + 1);
    Drawing._miniRegistry.set(key, {
      key, name: snap.name,
      points: (snap.points || []).map(p => ({ timestamp: p.timestamp, value: p.value })),
      styles: snap.styles || undefined, extendData: snap.extendData || undefined,
      lock: !!snap.lock, visible: snap.visible !== false, branchId: snap.branchId || null, _ovid: newId,
    });
    schedulePersist();
    return newId;
  }
  if (!Drawing.chart) return null;
  const opts = { name: snap.name, points: _pointsForChart(snap.points) };
  if (snap.styles)     opts.styles     = snap.styles;
  if (snap.extendData) opts.extendData = snap.extendData;
  if (snap.lock)       opts.lock       = true;
  if (snap.visible === false) opts.visible = false;
  let newId;
  try { newId = Drawing.chart.createOverlay(opts); } catch (e) { return null; }
  if (typeof newId !== 'string') return null;
  // Pull the chart-side overlay's points (now with dataIndex filled in by
  // KLineChart) for the registry copy — downstream consumers (reanchor,
  // persistence) want the full {timestamp, value, dataIndex} tuple.
  const bars = (window.App && window.App.currentBars) || [];
  const created = Drawing.chart.getOverlayById && Drawing.chart.getOverlayById(newId);
  const registryPoints = (created && created.points)
    ? created.points.map(p => ({ ...p }))
    : (snap.points || []).map(p => ({
        timestamp: p.timestamp,
        value: p.value,
        dataIndex: bars.length ? findDataIndexByTimestamp(bars, p.timestamp) : 0,
      }));
  Drawing.overlayRegistry.set(newId, {
    id: newId, name: snap.name, points: registryPoints,
    styles: snap.styles || undefined,
    extendData: snap.extendData || undefined,
    lock: !!snap.lock, visible: snap.visible !== false,
  });
  return newId;
}

function refreshContextMenuLabels() {
  const ov = Drawing.selectedOverlay;
  const lockLabel = document.querySelector('#ctx-menu .lock-label');
  const hideLabel = document.querySelector('#ctx-menu .hide-label');
  const pasteItem = document.querySelector('#ctx-menu [data-act="paste"]');
  const t = (window.I18n && window.I18n.t) || ((k) => k);
  if (lockLabel) lockLabel.textContent = ov && ov.lock           ? t('ctx.unlock') : t('ctx.lock');
  if (hideLabel) hideLabel.textContent = ov && ov.visible === false ? t('ctx.show')   : t('ctx.hide');
  if (pasteItem) pasteItem.classList.toggle('disabled', !Drawing.clipboard);
  // "繼續連接" only makes sense for completed paths.
  const isPath = ov && ov.name === 'path_done';
  document.querySelectorAll('#ctx-menu .path-only').forEach(el => {
    el.classList.toggle('hidden', !isPath);
  });
  // RR helpers only make sense on a long/short position box.
  const isPos = ov && (ov.name === 'long_position' || ov.name === 'short_position');
  document.querySelectorAll('#ctx-menu .position-only').forEach(el => {
    el.classList.toggle('hidden', !isPos);
  });
}

// =================================================================
// Chart-area context menu (right-click on empty chart)
// =================================================================
function initChartContextMenu() {
  const menu = document.getElementById('chart-ctx-menu');
  if (!menu) return;

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item || item.classList.contains('disabled')) return;
    e.stopPropagation();
    const act = item.dataset.act;
    switch (act) {
      case 'copy':         copySelected(); break;
      case 'paste':        pasteAtCrosshair(); break;
      case 'object-tree': {
        const btn = document.getElementById('btn-obj-tree');
        if (btn) btn.click();
        break;
      }
      case 'tpl-save-as':  /* commit 2 */ break;
      case 'settings':     openChartSettingsModal(); break;
      default:
        if (act && act.startsWith('tpl-apply-')) {
          /* commit 2 — apply named template */
        }
        break;
    }
    hideChartContextMenu();
  });

  // Close on outside click / Esc / scroll / blur / resize
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) hideChartContextMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideChartContextMenu();
  });
  window.addEventListener('blur', hideChartContextMenu);
  window.addEventListener('resize', hideChartContextMenu);
}

function showChartContextMenu(pageX, pageY) {
  const menu = document.getElementById('chart-ctx-menu');
  if (!menu) return;
  refreshChartContextMenuState();
  menu.classList.remove('hidden');
  // Clamp to viewport
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const x = Math.min(pageX, window.innerWidth - w - 5);
  const y = Math.min(pageY, window.innerHeight - h - 5);
  menu.style.left = Math.max(0, x) + 'px';
  menu.style.top  = Math.max(0, y) + 'px';
}

function hideChartContextMenu() {
  const menu = document.getElementById('chart-ctx-menu');
  if (menu) menu.classList.add('hidden');
}

/** Refresh enabled / disabled state per spec § "右鍵主圖":
 *    - 複製 disabled iff no selected overlay
 *    - 貼上 disabled iff no clipboard
 *  Saved-template rows are populated in commit 2. */
function refreshChartContextMenuState() {
  const menu = document.getElementById('chart-ctx-menu');
  if (!menu) return;
  const copyItem  = menu.querySelector('[data-act="copy"]');
  const pasteItem = menu.querySelector('[data-act="paste"]');
  if (copyItem)  copyItem.classList.toggle('disabled',  !Drawing.selectedOverlay);
  if (pasteItem) pasteItem.classList.toggle('disabled', !Drawing.clipboard);
}

// =================================================================
// Chart settings — color customization for K-bars + chart background,
// plus named templates. Storage is independent from drawing templates.
//
//   localStorage key: chart_viewer_chart_settings_v1
//   schema: { version, current: {7 colors}, templates: [{name, settings}] }
//
// Default colors mirror app.js's initial KLineChart styling so "套用
// 預設值" matches the as-shipped look.
// =================================================================
const CHART_SETTINGS_KEY = 'chart_viewer_chart_settings_v1';
const CHART_LANG_KEY     = 'chart_viewer_lang';
const CHART_LANG_DEFAULT = 'zh';
let _chartLang = CHART_LANG_DEFAULT;
let _chartLangSnapshot = null;       // for 取消 revert
const CHART_SETTINGS_DEFAULTS = Object.freeze({
  upBody:     '#26a69a',
  downBody:   '#ef5350',
  upBorder:   '#26a69a',
  downBorder: '#ef5350',
  upWick:     '#26a69a',
  downWick:   '#ef5350',
  bg:         '#131722',
  // 主體 visibility — when false, body fills paint as transparent so the
  // chart bg shows through (hollow candles). Borders + wicks always
  // render with their own colors. Default true matches the as-shipped
  // solid-body look.
  bodyVisible: true,
});

let _chartSettings = {
  current: { ...CHART_SETTINGS_DEFAULTS },
  templates: [],
};
let _chartSettingsSnapshot = null;   // snapshot at modal open (revert target)

function loadChartSettings() {
  try {
    const raw = localStorage.getItem(CHART_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.current && typeof parsed.current === 'object') {
        _chartSettings.current = { ...CHART_SETTINGS_DEFAULTS, ...parsed.current };
      }
      if (Array.isArray(parsed && parsed.templates)) {
        _chartSettings.templates = parsed.templates.filter(
          (t) => t && typeof t.name === 'string' && t.settings);
      }
    }
  } catch (e) { /* corrupt storage — ignore, keep defaults */ }
  // Language preference lives in its own key (UI-level concern, separate
  // from chart-content settings). Default 'zh' until the user changes.
  try {
    const lang = localStorage.getItem(CHART_LANG_KEY);
    if (lang === 'zh' || lang === 'en') _chartLang = lang;
  } catch (e) { /* ignore */ }
}

function saveChartSettings() {
  try {
    localStorage.setItem(CHART_SETTINGS_KEY, JSON.stringify({
      version: 1,
      current: _chartSettings.current,
      templates: _chartSettings.templates,
    }));
  } catch (e) { /* quota / private mode — ignore */ }
  try { localStorage.setItem(CHART_LANG_KEY, _chartLang); }
  catch (e) { /* ignore */ }
}

/** Apply a settings object to the live chart. Pass `_chartSettings.current`
 *  for the user's saved choice; pass CHART_SETTINGS_DEFAULTS to reset. */
function applyChartSettings(s) {
  if (!Drawing.chart || !Drawing.chart.setStyles) return;
  // When 主體 is on, candles paint solid (filled body). When off, switch
  // to KLineChart's native 'candle_stroke' chart type — both up and
  // down bars render hollow with no body fill, borders + wicks still
  // show. The setting lives on `candle.type` (chart-level), NOT on
  // `candle.bar.style` (which doesn't exist in KLineChart 9.x).
  const bodyOn = s.bodyVisible !== false;
  Drawing.chart.setStyles({
    candle: {
      type: bodyOn ? 'candle_solid' : 'candle_stroke',
      bar: {
        upColor:        s.upBody,
        downColor:      s.downBody,
        upBorderColor:  s.upBorder,
        downBorderColor:s.downBorder,
        upWickColor:    s.upWick,
        downWickColor:  s.downWick,
      },
    },
  });
  // KLineChart's canvas is transparent; the visible chart bg is the
  // host #chart element's background-color. Set both so any future
  // KLineChart version that does paint a bg colour stays in sync.
  const chartEl = document.getElementById('chart');
  if (chartEl) chartEl.style.backgroundColor = s.bg;
}

function initChartSettingsModal() {
  const modal    = document.getElementById('chart-settings-modal');
  if (!modal) return;
  const card     = modal.querySelector('.modal-card');
  const header   = card && card.querySelector('header');
  const closeBtn = document.getElementById('chart-settings-close');
  const cancel   = document.getElementById('chart-settings-cancel');
  const confirm  = document.getElementById('chart-settings-confirm');

  if (header && card) _installChartModalDrag(header, card);

  const closeAndRevert = () => {
    if (_chartSettingsSnapshot) {
      _chartSettings.current = { ..._chartSettingsSnapshot };
      applyChartSettings(_chartSettings.current);
      _chartSettingsSnapshot = null;
    }
    if (_chartLangSnapshot != null) {
      _chartLang = _chartLangSnapshot;
      _chartLangSnapshot = null;
    }
    modal.classList.add('hidden');
  };
  const closeAndCommit = () => {
    // Push undo entry only if anything actually changed since the
    // modal opened. Compare the snapshot (taken in openChartSettingsModal)
    // with the current state. JSON-stringify is good enough for these
    // small flat objects + a string.
    const beforeSettings = _chartSettingsSnapshot
      ? { ..._chartSettingsSnapshot } : null;
    const beforeLang = _chartLangSnapshot;
    const afterSettings = { ..._chartSettings.current };
    const afterLang = _chartLang;
    const changed = !beforeSettings
      || JSON.stringify(beforeSettings) !== JSON.stringify(afterSettings)
      || beforeLang !== afterLang;
    saveChartSettings();
    _chartSettingsSnapshot = null;
    _chartLangSnapshot = null;
    modal.classList.add('hidden');
    if (changed && beforeSettings) {
      pushUndo({
        label: 'Chart settings',
        undo: () => {
          _chartSettings.current = { ...beforeSettings };
          _chartLang = beforeLang;
          applyChartSettings(_chartSettings.current);
          saveChartSettings();
        },
        redo: () => {
          _chartSettings.current = { ...afterSettings };
          _chartLang = afterLang;
          applyChartSettings(_chartSettings.current);
          saveChartSettings();
        },
      });
    }
  };

  if (closeBtn) closeBtn.addEventListener('click', closeAndRevert);
  if (cancel)   cancel.addEventListener('click',   closeAndRevert);
  if (confirm)  confirm.addEventListener('click',  closeAndCommit);
  // No outside-click handler closes the modal itself. ✕ / 取消 / Esc
  // are the only paths out. But we DO close the color popover when the
  // user clicks anywhere outside it — see _installChartSettingsOutsideClick.
  _installChartSettingsOutsideClick();

  // Side-nav section switching. 快捷查看 is special: instead of being
  // an in-modal section it pops a standalone draggable window — close
  // the settings modal so the user has clean focus on the shortcuts
  // (and the settings modal's narrow card doesn't fight the wider
  // shortcuts card for screen real estate).
  modal.querySelectorAll('.modal-nav-item').forEach((nav) => {
    nav.addEventListener('click', () => {
      const target = nav.dataset.section;
      if (target === 'shortcuts') {
        modal.classList.add('hidden');
        openShortcutsWindow();
        return;
      }
      modal.querySelectorAll('.modal-nav-item').forEach((n) => n.classList.remove('active'));
      nav.classList.add('active');
      modal.querySelectorAll('.modal-section').forEach((s) => {
        s.classList.toggle('hidden', s.dataset.section !== target);
      });
    });
  });

  // ---- Color swatches ----
  modal.querySelectorAll('.cs-swatch').forEach((sw) => {
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = sw.dataset.key;
      if (!key) return;
      const cur = _chartSettings.current[key] || CHART_SETTINGS_DEFAULTS[key];
      openGenericColorPicker(sw, cur, 1, (newHex) => {
        _chartSettings.current[key] = newHex;
        sw.style.background = newHex;
        applyChartSettings(_chartSettings.current);   // live preview
      });
    });
  });

  // ---- 主體 visibility toggle ----
  modal.querySelectorAll('.cs-toggle').forEach((cb) => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.key;
      if (!key) return;
      _chartSettings.current[key] = cb.checked;
      applyChartSettings(_chartSettings.current);
    });
  });

  // ---- 語言設置 dropdown ----
  // English option is disabled until the i18n string dictionary lands;
  // the change event still fires for future-proofing. The selection
  // reverts via the snapshot if the user clicks 取消.
  const langSelect = document.getElementById('cs-lang-select');
  if (langSelect) {
    langSelect.addEventListener('change', () => {
      _chartLang = langSelect.value === 'en' ? 'en' : 'zh';
      // No live UI re-render — strings stay as-is until the dictionary
      // is wired in a future commit.
    });
  }

  // ---- Template picker ----
  const tplBtn  = document.getElementById('cs-tpl-button');
  const tplPop  = document.getElementById('cs-tpl-popover');
  if (tplBtn && tplPop) {
    tplBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willShow = tplPop.hasAttribute('hidden');
      if (willShow) {
        renderChartTemplateList();
        tplPop.removeAttribute('hidden');
      } else {
        tplPop.setAttribute('hidden', '');
      }
    });
    document.addEventListener('click', (e) => {
      if (tplPop.hasAttribute('hidden')) return;
      if (!tplPop.contains(e.target) && e.target !== tplBtn) {
        tplPop.setAttribute('hidden', '');
      }
    }, true);

    tplPop.addEventListener('click', (e) => {
      const item = e.target.closest('.cs-tpl-item');
      if (!item) return;
      // ✕ delete button on a saved template — handled separately below
      if (e.target.classList.contains('cs-tpl-x')) return;
      const act = item.dataset.act;
      if (act === 'default') {
        _chartSettings.current = { ...CHART_SETTINGS_DEFAULTS };
        applyChartSettings(_chartSettings.current);
        refreshChartSettingsSwatches();
        tplPop.setAttribute('hidden', '');
      } else if (act === 'save-as') {
        const name = (window.prompt(
          (window.I18n && window.I18n.t) ? window.I18n.t('dlg.tplNamePrompt') : '範本名稱',
          ''
        ) || '').trim();
        if (!name) return;
        // Replace if name collides; else append.
        const idx = _chartSettings.templates.findIndex((t) => t.name === name);
        const entry = { name, settings: { ..._chartSettings.current } };
        if (idx >= 0) _chartSettings.templates[idx] = entry;
        else          _chartSettings.templates.push(entry);
        saveChartSettings();
        renderChartTemplateList();
      } else if (act && act.startsWith('apply-')) {
        const idx = Number(act.slice('apply-'.length));
        const tpl = _chartSettings.templates[idx];
        if (!tpl) return;
        _chartSettings.current = { ...CHART_SETTINGS_DEFAULTS, ...tpl.settings };
        applyChartSettings(_chartSettings.current);
        refreshChartSettingsSwatches();
        tplPop.setAttribute('hidden', '');
      }
    });
  }

  // Esc closes (and reverts) when modal is open
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeAndRevert();
  });
}

function renderChartTemplateList() {
  const pop = document.getElementById('cs-tpl-popover');
  const sep = document.getElementById('cs-tpl-sep');
  if (!pop) return;
  // Wipe any previously-rendered saved rows.
  pop.querySelectorAll('.cs-tpl-saved').forEach((el) => el.remove());
  if (!_chartSettings.templates.length) {
    if (sep) sep.setAttribute('hidden', '');
    return;
  }
  if (sep) sep.removeAttribute('hidden');
  _chartSettings.templates.forEach((tpl, idx) => {
    const row = document.createElement('div');
    row.className = 'cs-tpl-item cs-tpl-saved';
    row.dataset.act = `apply-${idx}`;
    const delTitle = (window.I18n && window.I18n.t)
      ? window.I18n.t('common.delete') : '刪除';
    row.innerHTML = `<span></span><button class="cs-tpl-x" type="button" title="${delTitle}">✕</button>`;
    row.firstElementChild.textContent = tpl.name;
    row.querySelector('.cs-tpl-x').addEventListener('click', (e) => {
      e.stopPropagation();
      _chartSettings.templates.splice(idx, 1);
      saveChartSettings();
      renderChartTemplateList();
    });
    pop.appendChild(row);
  });
}

/** Close the shared `#sp-color-pop` color popover when the user
 *  clicks anywhere outside it AND outside any chart-settings swatch.
 *  Mirrors the pattern in `installPanelOutsideClickHandler` (which
 *  only fires when the drawing settings panel is open). Necessary
 *  because the color popover floats above everything at z-index
 *  10200 and otherwise has no way to close itself when the
 *  chart-settings modal is the host. */
function _installChartSettingsOutsideClick() {
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const modal = document.getElementById('chart-settings-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    const colorPop = document.getElementById('sp-color-pop');
    if (!colorPop || colorPop.classList.contains('hidden')) return;
    const onColorPop = colorPop.contains(e.target);
    const onSwatch   = !!e.target.closest('.cs-swatch');
    if (!onColorPop && !onSwatch) hideColorPopover();
  }, true);
}

/** Custom drag handler for the chart-settings modal header. Differs
 *  from makePanelDraggable: stops mousedown propagation so other
 *  document-level handlers don't see it (avoids a stale "click
 *  outside card" interpretation when the drag ends on the backdrop).
 *  Listeners on document are installed lazily on each drag start and
 *  removed on mouseup, so there's no permanent global cost. */
function _installChartModalDrag(header, card) {
  header.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;        // ✕ click stays a click
    e.preventDefault();
    e.stopPropagation();

    const rect = card.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = rect.left, startTop = rect.top;
    // Pin the card via explicit pixels and drop the centering transform
    // so subsequent left/top writes have a clear baseline.
    card.style.left = startLeft + 'px';
    card.style.top  = startTop  + 'px';
    card.style.transform = 'none';
    document.body.style.userSelect = 'none';

    const onMove = (ev) => {
      card.style.left = (startLeft + ev.clientX - startX) + 'px';
      card.style.top  = (startTop  + ev.clientY - startY) + 'px';
      // Color popover's anchor is the swatch we tied it to; if it's
      // open, hide it during drag so it doesn't visually detach.
      hideColorPopover();
    };
    const onUp = () => {
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup',   onUp,   true);
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup',   onUp,   true);
  });
}

/** Master keyboard-shortcut list rendered into the 設定 → 快捷查看
 *  section. Source of truth: keep this in sync when any module adds
 *  or changes a hotkey. Each entry's `keys` is an array — multiple
 *  arrays = "or" (e.g. Ctrl+Y vs Ctrl+Shift+Z for redo).
 *
 *  Spec i18n §3.13: `title` + `desc` are i18n KEYS. _renderShortcutsBody
 *  resolves them via I18n.t at render time, so language flips apply on
 *  the next 設定 → Keyboard Shortcuts open. */
const SHORTCUTS_DATA = [
  {
    title: 'tool.shortcuts.drawTools',
    items: [
      { keys: [['Alt', 'T']], desc: 'tool.trendline' },
      { keys: [['Alt', 'R']], desc: 'tool.rectangle' },
      { keys: [['Alt', 'C']], desc: 'tool.curve' },
      { keys: [['Alt', 'P']], desc: 'tool.path' },
      { keys: [['Alt', 'M'], ['Shift', 'Click']], desc: 'tool.measure' },
      { keys: [['Alt', 'L']], desc: 'tool.longPosition' },
      { keys: [['Alt', 'S']], desc: 'tool.shortPosition' },
      { keys: [['Alt', 'F']], desc: 'tool.fiboRetrace' },
      { keys: [['Alt', 'E']], desc: 'tool.fiboExtension' },
    ],
  },
  {
    title: 'tool.shortcuts.drawOps',
    items: [
      { keys: [['Esc']],          desc: 'tool.shortcuts.escAction' },
      { keys: [['Del']],          desc: 'tool.shortcuts.delAction' },
      { keys: [['Ctrl', 'C']],    desc: 'tool.shortcuts.copyAction' },
      { keys: [['Ctrl', 'X']],    desc: 'tool.shortcuts.cutAction' },
      { keys: [['Ctrl', 'V']],    desc: 'tool.shortcuts.pasteAction' },
      { keys: [['Ctrl', 'D']],    desc: 'tool.shortcuts.cloneAction' },
    ],
  },
  {
    title: 'tool.shortcuts.drawModifiers',
    items: [
      { keys: [['Ctrl']],   desc: 'tool.shortcuts.snapOhlc' },
      { keys: [['Shift']],  desc: 'tool.shortcuts.axisLock' },
    ],
  },
  {
    title: 'tool.shortcuts.history',
    items: [
      { keys: [['Ctrl', 'Z']],                          desc: 'tool.shortcuts.undo' },
      { keys: [['Ctrl', 'Y'], ['Ctrl', 'Shift', 'Z']],  desc: 'tool.shortcuts.redo' },
    ],
  },
  {
    title: 'tool.shortcuts.replay',
    items: [
      { keys: [['Shift', 'R']], desc: 'tool.shortcuts.replayToggle' },
      { keys: [['Space']],      desc: 'tool.shortcuts.replayPause' },
      { keys: [['.']],          desc: 'tool.shortcuts.replayStepFwd' },
      { keys: [[',']],          desc: 'tool.shortcuts.replayStepBack' },
    ],
  },
  {
    title: 'tool.shortcuts.timeframe',
    items: [
      { keys: [['0–9']],        desc: 'tool.shortcuts.tfDigitsHint' },
    ],
  },
  {
    title: 'tool.shortcuts.symbolSearch',
    items: [
      { keys: [['A–Z']],        desc: 'tool.shortcuts.symbolHint' },
    ],
  },
  {
    title: 'tool.shortcuts.simulation',
    items: [
      { keys: [['Shift', 'T']], desc: 'tool.shortcuts.tradeListToggle' },
    ],
  },
  {
    title: 'tool.shortcuts.branch',
    items: [
      { keys: [['Alt', 'F']],   desc: 'tool.shortcuts.forkPickMode' },
    ],
  },
];

function _renderShortcutsBody() {
  // Targets the standalone shortcuts window body, NOT a section in
  // the chart-settings modal. The earlier version selected by
  // [data-section="shortcuts"] which also matched the left-nav
  // entry — content was rendering inside the nav column.
  //
  // Spec i18n §3.13: re-renders on every call (no cache via
  // dataset.rendered) so language flips show on next open. The
  // i18n:change listener at the bottom of this file forces a fresh
  // render even if the window stays mounted.
  const sec = document.getElementById('shortcuts-window-body');
  if (!sec) return;
  const t = (window.I18n && window.I18n.t) || ((k) => k);
  // Wipe prior render so language switches don't leave stale text behind.
  sec.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const group of SHORTCUTS_DATA) {
    const g = document.createElement('div');
    g.className = 'cs-shortcut-group';
    const titleEl = document.createElement('div');
    titleEl.className = 'cs-group-title';
    titleEl.textContent = t(group.title);
    g.appendChild(titleEl);
    for (const item of group.items) {
      const row = document.createElement('div');
      row.className = 'cs-shortcut-row';
      const keysEl = document.createElement('div');
      keysEl.className = 'cs-shortcut-keys';
      // Each `combo` is an array of key tokens; multiple combos rendered
      // separated by "或" / "or". Within a combo, tokens joined by "+".
      item.keys.forEach((combo, comboIdx) => {
        if (comboIdx > 0) {
          const orEl = document.createElement('span');
          orEl.className = 'cs-kbd-or';
          orEl.textContent = t('tool.shortcuts.or');
          keysEl.appendChild(orEl);
        }
        combo.forEach((tok, tokIdx) => {
          if (tokIdx > 0) {
            const plus = document.createElement('span');
            plus.className = 'cs-kbd-plus';
            plus.textContent = '+';
            keysEl.appendChild(plus);
          }
          const k = document.createElement('span');
          k.className = 'cs-kbd';
          k.textContent = (window.I18n && window.I18n.macifyToken)
            ? window.I18n.macifyToken(tok)
            : tok;
          keysEl.appendChild(k);
        });
      });
      const desc = document.createElement('div');
      desc.className = 'cs-shortcut-desc';
      desc.textContent = t(item.desc);
      row.appendChild(keysEl);
      row.appendChild(desc);
      g.appendChild(row);
    }
    frag.appendChild(g);
  }
  sec.appendChild(frag);
}

function refreshChartSettingsSwatches() {
  const modal = document.getElementById('chart-settings-modal');
  if (!modal) return;
  modal.querySelectorAll('.cs-swatch').forEach((sw) => {
    const key = sw.dataset.key;
    if (key && _chartSettings.current[key]) {
      sw.style.background = _chartSettings.current[key];
    }
  });
  // Sync checkbox state with current settings (default true if absent).
  modal.querySelectorAll('.cs-toggle').forEach((cb) => {
    const key = cb.dataset.key;
    if (key) cb.checked = _chartSettings.current[key] !== false;
  });
}

// =================================================================
// Shortcuts reference window (standalone, draggable)
// =================================================================
function initShortcutsWindow() {
  const win = document.getElementById('shortcuts-window');
  if (!win) return;
  const card = win.querySelector('.sw-card');
  const header = card && card.querySelector('header');
  const closeBtn = document.getElementById('shortcuts-window-close');

  if (header && card) _installChartModalDrag(header, card);
  if (closeBtn) closeBtn.addEventListener('click', () => {
    closeShortcutsWindow();
    // ✕ goes "back" to the settings modal at the 商品 section
    // (NOT a full close). Re-show the modal directly (don't call
    // openChartSettingsModal — that would re-snapshot the settings
    // state, blowing away any in-progress color edits the user had
    // before they navigated to 快捷查看).
    _returnToChartSettingsAtSymbol();
  });

  // Esc behaves the same as ✕ — close shortcuts AND return to the
  // settings modal at 商品 (back-navigation, not full exit).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !win.classList.contains('hidden')) {
      closeShortcutsWindow();
      _returnToChartSettingsAtSymbol();
    }
  });

  // Render the body once at init — content never changes after.
  _renderShortcutsBody();
}

function openShortcutsWindow() {
  const win = document.getElementById('shortcuts-window');
  if (!win) return;
  // Reset to CSS-default position (top: 80px + horizontal center).
  // Clear inline styles left by a previous drag session.
  const card = win.querySelector('.sw-card');
  if (card) {
    card.style.left = '';
    card.style.top  = '';
    card.style.transform = '';
  }
  win.classList.remove('hidden');
}

function closeShortcutsWindow() {
  const win = document.getElementById('shortcuts-window');
  if (win) win.classList.add('hidden');
}

/** Re-show the chart-settings modal at the 商品 section. Called by
 *  the shortcuts window ✕ so the user returns to where they came from
 *  rather than ending up on a blank chart. Does NOT re-snapshot
 *  settings state (any in-progress color edits stay live). */
function _returnToChartSettingsAtSymbol() {
  const modal = document.getElementById('chart-settings-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.querySelectorAll('.modal-nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.section === 'symbol');
  });
  modal.querySelectorAll('.modal-section').forEach((s) => {
    s.classList.toggle('hidden', s.dataset.section !== 'symbol');
  });
}

function openChartSettingsModal() {
  const modal = document.getElementById('chart-settings-modal');
  if (!modal) return;
  // Snapshot current settings so 取消 / Esc / ✕ can revert any live-
  // preview changes the user made via swatch / toggle / lang dropdown.
  _chartSettingsSnapshot = { ..._chartSettings.current };
  _chartLangSnapshot     = _chartLang;
  refreshChartSettingsSwatches();
  // Sync language dropdown to current preference.
  const langSelect = document.getElementById('cs-lang-select');
  if (langSelect) langSelect.value = _chartLang;
  // Reset the card to its CSS-default position on every open so a
  // dragged-then-closed session doesn't preserve the off-screen
  // location. Clear the inline styles set by _installChartModalDrag
  // (left/top/transform) — CSS takes over with `top: 80px` + horizontal
  // center, top-anchored so section switches don't visually jump.
  const card = modal.querySelector('.modal-card');
  if (card) {
    card.style.left = '';
    card.style.top  = '';
    card.style.transform = '';
  }
  modal.classList.remove('hidden');
  // Default to 商品 section on every open.
  modal.querySelectorAll('.modal-nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.section === 'symbol');
  });
  modal.querySelectorAll('.modal-section').forEach((s) => {
    s.classList.toggle('hidden', s.dataset.section !== 'symbol');
  });
}

// =================================================================
// Clipboard / overlay actions
// =================================================================
// Spec i18n §3.2: overlay-name map now stores i18n KEYS, not labels.
// Each consumer translates via I18n.t() so language flips apply on the
// next render. Falls back to panel.drawing.title (= "繪圖" / "Drawing")
// for unknown overlay names.
const _OVERLAY_NAME_KEYS = {
  trendline_snap: 'tool.trendline',
  curve_snap:     'tool.curve',
  rectangle_snap: 'tool.rectangle',
  path_snap:      'tool.path',
  path_done:      'tool.path',
  measure_snap:   'tool.measure',
  long_position:  'tool.longPosition',
  short_position: 'tool.shortPosition',
  fibo_retrace:   'tool.fiboRetrace',
  fibo_extension: 'tool.fiboExtension',
  fibo_time:      'tool.fiboTime',
};
function getOverlayDisplayName(ov) {
  const t = (window.I18n && window.I18n.t) || ((k) => k);
  if (!ov) return t('panel.drawing.title');
  // A text box is a rectangle_snap under the hood — show it as 文字, not 矩形.
  if (ov.name === 'rectangle_snap' && ov.extendData && ov.extendData.textBox) return t('tool.text');
  const key = _OVERLAY_NAME_KEYS[ov.name];
  return key ? t(key) : t('panel.drawing.title');
}

function snapshot(ov) {
  if (!ov) return null;
  const bars = (window.App && window.App.currentBars) || [];
  const points = (ov.points || []).map(p => {
    const out = { value: p.value };
    const ts = timestampFromPoint(p, bars);
    if (Number.isFinite(ts)) out.timestamp = ts;
    return out;
  });
  return {
    name: ov.name === 'path_snap' ? 'path_done' : ov.name,
    points,
    styles: ov.styles ? JSON.parse(JSON.stringify(ov.styles)) : undefined,
    // Carry extendData so copy/clone preserves text labels on rectangles +
    // trendlines (stored in extendData.text), position params on long/short
    // position overlays, etc. Without this the pasted overlay loses the text.
    extendData: ov.extendData ? JSON.parse(JSON.stringify(ov.extendData)) : undefined,
  };
}

function copySelected() {
  // _fullOverlaySnapshot (not snapshot) so the clipboard carries the source
  // overlay's host + branch + canonical mini points — paste then recreates on
  // the SAME chart it was copied from.
  const snap = _fullOverlaySnapshot(Drawing.selectedOverlay);
  if (snap) Drawing.clipboard = snap;
}

function cutSelected() {
  if (!Drawing.selectedOverlay) return;
  copySelected();
  removeSelected();
}

// Translate a points array by (dt, dv) in (timestamp, value) space.
// snapshot() guarantees timestamp is set, so we always offset timestamp.
function translatePoints(points, dt, dv) {
  return points.map(p => ({
    timestamp: (p.timestamp || 0) + dt,
    value: (p.value || 0) + dv,
  }));
}

// Recreate a translated copy of a snapshot on the chart it belongs to, tracked
// into the right registry — the host-aware primitive behind clone / paste /
// z-order. A `host:'mini'` snapshot (from _fullOverlaySnapshot) rebuilds on the
// mini chart + _miniRegistry (branch = the snapshot's own mini branch); a main
// snapshot rebuilds on the main chart via trackOverlay (branch = active). This
// deliberately does NOT reuse _recreateFromSnapshot for the main path, because
// that primitive (shared with delete-undo) leaves branchId unstamped — which
// would drop a clone/paste out of its branch scope. Returns the new id or null.
function _createTranslatedCopy(snap, dt, dv) {
  if (!snap || !snap.points) return null;
  // Paste/clone runs while Ctrl (or Shift) is still held from the Ctrl+V / Ctrl+D
  // shortcut. Each point below carries a dataIndex (needed so the copy is
  // body-DRAGGABLE), and createOverlay runs applySnap on dataIndex-bearing
  // points — so with Ctrl held the OHLC magnet fires and snaps the copy's
  // corners onto bars, shifting it in Y (Aaron: "Y 軸與複製前不一樣"). Suppress
  // the snap for the whole recreate, then restore the real held state.
  const ss = window.SnapState || {};
  const savedCtrl = ss.ctrlHeld, savedShift = ss.shiftHeld;
  ss.ctrlHeld = false; ss.shiftHeld = false;
  try {
    return _createTranslatedCopyImpl(snap, dt, dv);
  } finally {
    ss.ctrlHeld = savedCtrl; ss.shiftHeld = savedShift;
  }
}
function _createTranslatedCopyImpl(snap, dt, dv) {
  const pts = translatePoints(snap.points, dt, dv);
  const extendData = snap.extendData ? JSON.parse(JSON.stringify(snap.extendData)) : undefined;
  if (snap.host === 'mini') {
    const miniChart = window.MiniChart && window.MiniChart.chart;
    if (!miniChart) return null;             // mini closed → can't place it there
    const data = miniChart.getDataList ? miniChart.getDataList() : [];
    const idxByTs = (ts) => { let b = 0; for (let i = 0; i < data.length; i++) { if (data[i].timestamp <= ts) b = i; else break; } return b; };
    const withIdx = pts.map(p => ({ timestamp: p.timestamp, value: p.value, dataIndex: idxByTs(p.timestamp) }));
    const opts = { name: snap.name, points: withIdx };
    if (snap.styles) opts.styles = snap.styles;
    if (extendData)  opts.extendData = extendData;
    let newId;
    try { newId = miniChart.createOverlay(opts); } catch (e) { return null; }
    if (typeof newId !== 'string') return null;
    if (!Drawing._miniRegistry) Drawing._miniRegistry = new Map();
    const key = 'm' + (Drawing._miniSeq = (Drawing._miniSeq || 0) + 1);
    const mbid = snap.branchId || (window.BranchEngine && window.BranchEngine.miniBranchId) || 'main';
    Drawing._miniRegistry.set(key, {
      key, name: snap.name,
      points: pts.map(p => ({ timestamp: p.timestamp, value: p.value })),
      styles: snap.styles || undefined, extendData: extendData || undefined,
      lock: false, visible: true, branchId: mbid, _ovid: newId,
    });
    schedulePersist();
    return newId;
  }
  if (!Drawing.chart) return null;
  // Attach a dataIndex per point (like the mini path above) so KLineChart's
  // native body-drag — which moves the overlay in dataIndex space — can move the
  // copy. Y stays exact because the OHLC magnet is suppressed by the guard in
  // the wrapper (createOverlay with a dataIndex would otherwise snap Y whenever
  // Ctrl is held, which it is during Ctrl+V / Ctrl+D).
  const data = Drawing.chart.getDataList ? Drawing.chart.getDataList() : [];
  const idxByTs = (ts) => { let b = 0; for (let i = 0; i < data.length; i++) { if (data[i].timestamp <= ts) b = i; else break; } return b; };
  const withIdx = pts.map(p => ({ timestamp: p.timestamp, value: p.value, dataIndex: idxByTs(p.timestamp) }));
  const opts = { name: snap.name, points: withIdx };
  if (snap.styles) opts.styles = snap.styles;
  if (extendData)  opts.extendData = extendData;
  const newId = Drawing.chart.createOverlay(opts);
  if (typeof newId === 'string') {
    trackOverlay({ id: newId, name: snap.name, points: withIdx, styles: snap.styles, extendData });
  }
  return typeof newId === 'string' ? newId : null;
}

function pasteAtCrosshair() {
  if (!Drawing.clipboard || !Drawing.chart) return;
  const cb = Drawing.clipboard;
  const src = cb.points && cb.points[0];
  if (!src) return;
  const target = Drawing.lastCrosshair;
  let dt, dv;
  if (target && Number.isFinite(target.timestamp) && Number.isFinite(src.timestamp)) {
    dt = target.timestamp - src.timestamp;
    dv = target.value - src.value;
  } else {
    // Fallback: shift by +5 bars worth of time using current TF
    dt = guessCurrentTfMs() * 5;
    dv = 0;
  }
  // Host-aware: a mini-copied overlay pastes back onto the mini (its own
  // registry/branch), a main-copied one onto the main. If the mini was closed
  // after copy, _createTranslatedCopy returns null and the paste is a no-op.
  _createTranslatedCopy(cb, dt, dv);
  // Clear JS-side selection so neither the source nor the pasted overlay
  // hijacks the next click. Without this, `Drawing.selectedOverlay` is
  // still the source overlay (from the right-click that triggered copy),
  // so hovering its corners shows a resize cursor and clicking starts a
  // resize-drag on the SOURCE — confusing the user who's trying to grab
  // the freshly-pasted overlay. Once cleared, the next click on either
  // overlay goes through KLineChart's onSelected → selectedOverlay
  // updates to whatever was clicked.
  Drawing.selectedOverlay = null;
  refreshObjectTree();
}

function cloneSelected() {
  // Host-aware snapshot → recreate on the same chart (mini clone stays on the
  // mini). Offset +5 bars so the copy doesn't sit exactly on the original.
  const snap = _fullOverlaySnapshot(Drawing.selectedOverlay);
  if (!snap) return;
  _createTranslatedCopy(snap, guessCurrentTfMs() * 5, 0);
  // Clear selection — same reasoning as pasteAtCrosshair: keeping the
  // source overlay selected would have its handles hijack the next click.
  Drawing.selectedOverlay = null;
  refreshObjectTree();
}

function guessCurrentTfMs() {
  // Delegate to replay.js's parseTfMs (same convention — plain digits = minutes).
  if (window.Replay && typeof window.Replay.parseTfMs === 'function') {
    return window.Replay.parseTfMs((window.App && window.App.currentTF) || '15');
  }
  const tf = (window.App && window.App.currentTF) || '15';
  const m = tf.match(/^(\d+)(min|[mhdw])?$/i);
  if (!m) return 60000;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 'min').toLowerCase();
  return n * ({
    min: 60000, m: 30 * 86400000, h: 3600000, d: 86400000, w: 7 * 86400000,
  }[unit] || 60000);
}

function removeSelected() {
  if (!Drawing.selectedOverlay || !Drawing.chart) return;
  const ov = Drawing.selectedOverlay;
  const snap = _fullOverlaySnapshot(ov);
  const id = ov.id;
  _chartOf(id).removeOverlay({ id });
  untrackOverlay(id);
  Drawing.selectedOverlay = null;
  refreshObjectTree();
  if (snap) {
    // Each undo cycle creates a NEW overlay id — track it in the
    // closure so subsequent redo can target the recreated overlay.
    const ref = { id };
    pushUndo({
      label: 'Delete overlay',
      undo: () => {
        const newId = _recreateFromSnapshot(snap);
        if (newId) { ref.id = newId; refreshObjectTree(); }
      },
      redo: () => {
        try { _chartOf(ref.id).removeOverlay({ id: ref.id }); } catch (e) {}
        untrackOverlay(ref.id);
        if (Drawing.selectedOverlay && Drawing.selectedOverlay.id === ref.id) {
          Drawing.selectedOverlay = null;
        }
        refreshObjectTree();
      },
    });
  }
}

function toggleLock() {
  const ov = Drawing.selectedOverlay;
  if (!ov || !Drawing.chart) return;
  _chartOf(ov.id).overrideOverlay({ id: ov.id, lock: !ov.lock });
  ov.lock = !ov.lock;
  updateTrackedOverlay(ov.id, { lock: ov.lock });
}

function toggleVisible() {
  const ov = Drawing.selectedOverlay;
  if (!ov || !Drawing.chart) return;
  const newVis = ov.visible === false ? true : false;
  _chartOf(ov.id).overrideOverlay({ id: ov.id, visible: newVis });
  ov.visible = newVis;
  updateTrackedOverlay(ov.id, { visible: newVis });
  refreshObjectTree();
}

// =================================================================
// Z-ORDER — driven by KLineChart's own `zLevel`
// =================================================================
// Measured against klinecharts 9.8.10 (probe run in this session):
//   - the overlay store sorts instances by `zLevel` ascending
//     (`e.sort((a,b) => a.zLevel - b.zLevel)`), higher = drawn later = on top;
//   - hit-testing walks the figure children in REVERSE, so topmost wins;
//   - on mouse ENTER the store calls `instance.setZLevel(Number.MAX_SAFE_INTEGER)`
//     and NEVER restores it on leave.
// That last one is the whole bug: a rectangle big enough to cover the chart is
// unavoidably hovered, sticks at MAX_SAFE_INTEGER forever, and from then on
// swallows every click - nothing underneath can be selected again. It also
// explains why re-creating overlays in a chosen order never held: the next
// hover re-sorted them anyway.
//
// Fix = own the zLevel instead of fighting it:
//   1. give every overlay a stable zLevel ranked by AREA (bigger area -> lower),
//      so a small object always sits above the rectangle that contains it;
//   2. restore that zLevel on mouse leave, undoing the MAX_SAFE_INTEGER bump
//      (hover-on-top while pointing at it is fine - permanent is not).
// No overlay is recreated, so ids, undo history and persistence are untouched.
const Z_MANUAL_TOP = 1e6;      // 置頂 / 置底 sit outside the auto-ranked band
const Z_MANUAL_BOTTOM = -1e6;
let _zManualSeq = 0;

function _overlayBox(entry) {
  const pts = entry && entry.points;
  if (!Array.isArray(pts) || pts.length < 2) return null;
  // A freshly drawn overlay's points can still be dataIndex-only (timestamp is
  // filled in later), so resolve through the bars — otherwise its area is
  // unmeasurable and it sinks to the bottom of the stack.
  const bars = (window.App && window.App.currentBars) || [];
  const ts = pts.map(p => timestampFromPoint(p, bars)).filter(Number.isFinite);
  const vs = pts.map(p => p.value).filter(Number.isFinite);
  if (ts.length < 2 || vs.length < 2) return null;
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const v0 = Math.min(...vs), v1 = Math.max(...vs);
  return { t0, t1, v0, v1, area: (t1 - t0) * (v1 - v0) };
}

/** Push an overlay's assigned zLevel into the chart (and remember it). */
function _applyZLevel(entry, z) {
  const chart = _chartOf(entry.id);
  const live = chart && chart.getOverlayById && chart.getOverlayById(entry.id);
  // Compare against the LIVE instance too: if a hover bump slipped through
  // (overlay tracked but not yet ranked), entry.zLevel can already equal `z`
  // while the instance sits at MAX_SAFE_INTEGER — skipping the write there would
  // leave it stuck on top.
  if (entry.zLevel === z && live && live.zLevel === z) return false;
  entry.zLevel = z;
  try { chart.overrideOverlay({ id: entry.id, zLevel: z }); }
  catch (e) { return false; }
  return true;
}

/** Rank every (non-manual) overlay by area: biggest at the bottom. Cheap enough
 *  to run after any structural change - it only writes when a level changes. */
function applyAutoZLevels() {
  if (!Drawing.chart || !Drawing.overlayRegistry) return 0;
  const ranked = [...Drawing.overlayRegistry.values()]
    .filter(e => !e.zManual)
    .map(e => ({ e, area: (_overlayBox(e) || {}).area }))
    .sort((x, y) => {
      const ax = Number.isFinite(x.area) ? x.area : Infinity;   // unmeasurable -> keep low
      const ay = Number.isFinite(y.area) ? y.area : Infinity;
      return ay - ax;                                           // bigger first = lower
    });
  let changed = 0;
  ranked.forEach((r, i) => { if (_applyZLevel(r.e, i + 1)) changed++; });
  return changed;
}
Drawing.applyAutoZLevels = applyAutoZLevels;

/** Coalesced applyAutoZLevels — many overlays can be tracked back-to-back
 *  (restore, paste, a programmatic batch draw), and one pass at the
 *  end of the task is enough. */
let _autoZPending = false;
function scheduleAutoZLevels() {
  if (_autoZPending) return;
  _autoZPending = true;
  setTimeout(() => { _autoZPending = false; try { applyAutoZLevels(); } catch (e) {} }, 0);
}
Drawing.scheduleAutoZLevels = scheduleAutoZLevels;

/** Write our assigned zLevel straight back onto the live instance, synchronously.
 *  Called from onMouseEnter, which KLineChart invokes AFTER its
 *  setZLevel(MAX_SAFE_INTEGER) but BEFORE the re-sort — so the bump never lands.
 *  Uses the instance's own setter (not overrideOverlay) to stay inside that
 *  window and avoid a second render pass. */
function cancelHoverZBump(overlay) {
  if (!overlay || typeof overlay.setZLevel !== 'function') return;
  const entry = Drawing.overlayRegistry.get(overlay.id);
  const z = entry && Number.isFinite(entry.zLevel) ? entry.zLevel : null;
  if (z == null) return;
  if (overlay.zLevel !== z) overlay.setZLevel(z);
}
Drawing.cancelHoverZBump = cancelHoverZBump;

/** Undo KLineChart's hover bump so "last hovered" doesn't become "permanently
 *  on top". Belt-and-braces for paths that skip onMouseEnter. */
function restoreZLevelAfterHover(id) {
  if (!id) return;
  const entry = Drawing.overlayRegistry.get(id);
  if (!entry || !Number.isFinite(entry.zLevel)) return;
  try { _chartOf(id).overrideOverlay({ id, zLevel: entry.zLevel }); } catch (e) {}
}
Drawing.restoreZLevelAfterHover = restoreZLevelAfterHover;

// Alias kept for the call sites added earlier this session (restore / draw end).
function raiseEnclosedOverlays() { return applyAutoZLevels(); }
Drawing.raiseEnclosedOverlays = raiseEnclosedOverlays;

function setZOrder(toTop) {
  const ov = Drawing.selectedOverlay;
  if (!ov || !Drawing.chart) return;
  // zLevel makes this a one-line property change - no remove+recreate, so the
  // overlay keeps its id, undo history and branch stamp. (The old code called
  // chart.getOverlays(), which does NOT exist in klinecharts 9.8.10: it returned
  // undefined, the whole "rotate the others" branch became a no-op, and 置底
  // silently did 置頂 instead. That is why it looked like it had no effect.)
  const entry = Drawing.overlayRegistry.get(ov.id);
  const z = (toTop ? Z_MANUAL_TOP : Z_MANUAL_BOTTOM) + (toTop ? ++_zManualSeq : -(++_zManualSeq));
  if (entry) {
    entry.zManual = true;                    // opt out of the area ranking
    _applyZLevel(entry, z);
    schedulePersist();
  } else {
    try { _chartOf(ov.id).overrideOverlay({ id: ov.id, zLevel: z }); } catch (e) {}
  }
  refreshObjectTree();
}

// =================================================================
// Settings panel
// =================================================================
// Color palette: row 0 = grayscale, rows 1-5 = 10 hues × 5 lightness levels
const PALETTE = (() => {
  const hslToHex = (h, s, l) => {
    s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r, g, b;
    if (h < 60)      [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else              [r, g, b] = [c, 0, x];
    const to = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return ('#' + to(r) + to(g) + to(b)).toUpperCase();
  };
  const HUES = [0, 25, 45, 75, 130, 175, 200, 225, 270, 320];
  const COLS = 10;
  const rows = [];
  // Row 0: grayscale white→black
  const grays = [];
  for (let i = 0; i < COLS; i++) {
    const l = Math.round(100 - i * (100 / (COLS - 1)));
    grays.push(hslToHex(0, 0, l));
  }
  rows.push(grays);
  // Rows 1-5: hues at varying lightness
  for (const l of [85, 70, 55, 40, 25]) {
    rows.push(HUES.map(h => hslToHex(h, 75, l)));
  }
  return rows.flat();
})();

// Line style presets — map UI choice to KLineChart style+dashedValue
const LINE_STYLE_PRESETS = {
  solid:  { style: 'solid', dashedValue: undefined },
  dashed: { style: 'dashed', dashedValue: [6, 4] },
  dotted: { style: 'dashed', dashedValue: [14, 8] },  // wide-segment, wide-gap
};

function detectLineStyleKey(line) {
  if (!line || line.style === 'solid' || !line.style) return 'solid';
  const dv = line.dashedValue;
  if (Array.isArray(dv) && dv.length >= 2 && dv[0] >= 10) return 'dotted';
  return 'dashed';
}

const SP = {
  panel: null,
  originalState: null,    // {styles, visible, lock, extendData} for cancel revert
  // Per-target color state:
  //   '1'    = main/border
  //   '2'    = background (rect only)
  //   'text' = text color (rect text label)
  colors: {
    '1':    { hex: '#2962FF', opacity: 1 },
    '2':    { hex: '#2962FF', opacity: 0.2 },
    'text': { hex: '#FFFFFF', opacity: 1 },
  },
  popoverTarget: '1',     // which swatch the color popover currently edits
};

// Per-type style inheritance: once user customizes a shape (color / line
// style / opacity / text styling), the NEXT shape of the same type drawn
// picks up those same settings. Text CONTENT is always cleared so labels
// don't copy across drawings. Each type has its own bucket.
const DRAWING_INHERITED = {
  trendline_snap: null,   // { styles, extendData }
  rectangle_snap: null,
  path_done:      null,   // path_snap shares this bucket
  measure_snap:   null,
  long_position:  null,
  short_position: null,
};

function _inheritBucket(name) {
  if (name === 'path_snap') return 'path_done';
  return name;
}
function captureInheritedStyle(name, styles, extendData) {
  const bucket = _inheritBucket(name);
  if (!(bucket in DRAWING_INHERITED)) return;
  DRAWING_INHERITED[bucket] = {
    styles: styles ? JSON.parse(JSON.stringify(styles)) : null,
    // Inherit text style attrs but strip the literal content.
    extendData: (extendData && extendData.text) ? {
      text: { ...extendData.text, content: '' },
    } : null,
  };
}
function getInheritedStyle(name) {
  return DRAWING_INHERITED[_inheritBucket(name)] || null;
}

// Default text state for rectangles (persisted on the overlay's extendData).
const DEFAULT_TEXT_STATE = {
  content: '',
  size: 20,
  bold: false,
  italic: false,
  color: { hex: '#FFFFFF', opacity: 1 },
  vPos: 'inside',          // 'top' | 'inside' | 'bottom'
  hAlign: 'center',        // 'left' | 'center' | 'right'
};

// Shared 2D canvas for measureText (created lazily, reused thereafter).
let __textMeasureCtx = null;
function _textMeasureCtx() {
  if (!__textMeasureCtx) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    __textMeasureCtx = c.getContext('2d');
  }
  return __textMeasureCtx;
}

// Greedy word wrap. ctx.font must be set before calling.
// Falls back to per-char wrap when a single token exceeds maxWidth.
function wrapLine(ctx, text, maxWidth) {
  if (!text) return [''];
  const out = [];
  const words = text.split(/(\s+)/);   // keep whitespace groups
  let cur = '';
  const push = () => { if (cur) { out.push(cur); cur = ''; } };
  for (const w of words) {
    if (!w) continue;
    const tentative = cur + w;
    if (ctx.measureText(tentative).width <= maxWidth) { cur = tentative; continue; }
    // Doesn't fit. Flush current, then try to place w.
    push();
    if (ctx.measureText(w).width <= maxWidth) { cur = w; continue; }
    // Single token too long → char-by-char wrap.
    for (const ch of w) {
      const t2 = cur + ch;
      if (ctx.measureText(t2).width <= maxWidth) cur = t2;
      else { push(); cur = ch; }
    }
  }
  push();
  return out.length ? out : [''];
}

function initSettingsPanel(chart) {
  SP.panel = document.getElementById('settings-panel');

  document.getElementById('sp-close').addEventListener('click', cancelSettings);
  document.getElementById('sp-cancel').addEventListener('click', cancelSettings);
  document.getElementById('sp-confirm').addEventListener('click', confirmSettings);

  // Enter = 確認 while the drawing settings panel is open. Skipped when:
  //   - focus is in the multi-line text <textarea> (Enter must insert a newline)
  //   - a sub-popover/modal is open (colour / template / save-as own their keys)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;          // IME compose → ignore
    if (!SP.panel || SP.panel.classList.contains('hidden')) return;        // panel not open
    const ae = document.activeElement;
    if (ae && ae.tagName === 'TEXTAREA') return;                           // keep newline in text editing
    const open = id => { const el = document.getElementById(id); return el && !el.classList.contains('hidden'); };
    if (open('sp-color-pop') || open('sp-template-pop') || open('tpl-save-modal')) return;
    e.preventDefault();
    confirmSettings();
  });

  // Tab switching
  SP.panel.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      SP.panel.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      SP.panel.querySelectorAll('.tab-body').forEach(b => {
        b.classList.toggle('hidden', b.dataset.tab !== tab.dataset.tab);
      });
    });
  });

  // Build color grid
  const grid = document.getElementById('sp-color-grid');
  PALETTE.forEach(hex => {
    const cell = document.createElement('div');
    cell.className = 'color-cell';
    cell.style.background = hex;
    cell.dataset.color = hex;
    cell.title = hex;
    cell.addEventListener('click', () => {
      setActiveColor(SP.popoverTarget, hex, getColorState(SP.popoverTarget).opacity);
      hideColorPopover();
    });
    grid.appendChild(cell);
  });

  // Color swatch buttons (multiple, identified by data-target)
  SP.panel.querySelectorAll('.color-swatch').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openColorPopover(btn.dataset.target || '1');
    });
  });

  // (Outside-click popover-close is now handled by installPanelOutsideClickHandler.)

  // Custom color input
  document.getElementById('sp-color-custom').addEventListener('input', (e) => {
    setActiveColor(SP.popoverTarget, e.target.value.toUpperCase(),
      getColorState(SP.popoverTarget).opacity);
  });

  // Opacity slider — applies to whichever target the popover is editing
  const opIn = document.getElementById('sp-opacity');
  opIn.addEventListener('input', () => {
    const op = parseInt(opIn.value, 10) / 100;
    document.getElementById('sp-opacity-val').textContent = opIn.value + '%';
    setActiveColor(SP.popoverTarget, getColorState(SP.popoverTarget).hex, op);
  });

  // Thickness buttons
  SP.panel.querySelectorAll('.th-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      SP.panel.querySelectorAll('.th-btn').forEach(b => b.classList.toggle('active', b === btn));
      applyLive();
    });
  });

  // Line style buttons
  SP.panel.querySelectorAll('.ls-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      SP.panel.querySelectorAll('.ls-btn').forEach(b => b.classList.toggle('active', b === btn));
      applyLive();
    });
  });

  // Visibility / lock checkboxes
  document.getElementById('sp-visible').addEventListener('change', applyLive);
  document.getElementById('sp-locked').addEventListener('change', applyLive);
  const borderCb = document.getElementById('sp-border-enabled');
  if (borderCb) {
    borderCb.addEventListener('change', () => {
      _syncBorderSwatchDisabled();
      applyLive();
    });
  }

  // Curve-only toggles: end arrows + tangent extensions (each flips its own
  // .active and re-applies; applyLive reads them into extendData.curve).
  ['sp-curve-arrow-left', 'sp-curve-arrow-right', 'sp-curve-extend-left', 'sp-curve-extend-right'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', (e) => { e.currentTarget.classList.toggle('active'); applyLive(); });
  });

  // Text tab controls
  document.getElementById('sp-text-content').addEventListener('input', applyLive);
  document.getElementById('sp-text-size').addEventListener('change', applyLive);
  document.getElementById('sp-text-vpos').addEventListener('change', applyLive);
  document.getElementById('sp-text-halign').addEventListener('change', applyLive);
  ['sp-text-bold', 'sp-text-italic'].forEach(id => {
    document.getElementById(id).addEventListener('click', (e) => {
      e.currentTarget.classList.toggle('active');
      applyLive();
    });
  });
  // Text-box only: background / border / word-wrap toggles.
  ['sp-textbox-bg-enabled', 'sp-textbox-border-enabled', 'sp-textbox-wrap'].forEach(id => {
    const cb = document.getElementById(id);
    if (cb) cb.addEventListener('change', applyLive);
  });

  // Drag + outside-click behaviors
  makePanelDraggable(SP.panel);
  installPanelOutsideClickHandler();

  // Template system
  initTemplateSystem();
}

// "Generic" mode lets non-SP callers (e.g. the position dialog's 樣式
// tab) borrow the same color popover. When _genericPicker is non-null,
// every swatch/palette/custom/opacity event re-routes to its callback
// + anchor instead of touching SP.colors and SP.panel.
//
// CRITICAL: also tracks the current { hex, opacity } so the opacity
// slider's input handler can read "the current hex" without going
// through SP.popoverTarget (which is unset in generic mode and would
// otherwise fall back to the default blue, painting every swatch
// blue the moment the user touched the slider).
let _genericPicker = null;

function getColorState(target) {
  if (_genericPicker) return { hex: _genericPicker.hex, opacity: _genericPicker.opacity };
  return SP.colors[target] || { hex: '#2962FF', opacity: 1 };
}

function setActiveColor(target, hex, opacity) {
  if (_genericPicker) {
    _genericPicker.hex = hex;
    _genericPicker.opacity = opacity;
    _genericPicker.cb(hex, opacity);
    const anchor = _genericPicker.anchor;
    if (anchor) anchor.style.background = hexToRgba(hex, opacity);
    return;
  }
  SP.colors[target] = { hex, opacity };
  const btn = SP.panel.querySelector(`.color-swatch[data-target="${target}"]`);
  if (btn) btn.style.background = hexToRgba(hex, opacity);
  applyLive();
}

// Internal: position the popover next to the given anchor + sync controls.
function _showColorPopover(anchor, hex, opacity) {
  const pop = document.getElementById('sp-color-pop');
  document.getElementById('sp-color-custom').value = hex.toLowerCase();
  const opIn = document.getElementById('sp-opacity');
  const opPct = Math.round(opacity * 100);
  opIn.value = opPct;
  document.getElementById('sp-opacity-val').textContent = opPct + '%';
  document.querySelectorAll('#sp-color-grid .color-cell').forEach(c => {
    c.classList.toggle('active', c.dataset.color.toLowerCase() === hex.toLowerCase());
  });
  pop.classList.remove('hidden');
  if (!anchor) return;
  const sRect = anchor.getBoundingClientRect();
  const popW = pop.offsetWidth;
  const popH = pop.offsetHeight;
  const margin = 8;
  let left = sRect.right + margin;
  if (left + popW > window.innerWidth - 5) left = sRect.left - popW - margin;
  if (left < 5) left = 5;
  let top = sRect.top;
  if (top + popH > window.innerHeight - 5) top = window.innerHeight - popH - 5;
  if (top < 5) top = 5;
  pop.style.left = left + 'px';
  pop.style.top  = top + 'px';
}

function openColorPopover(target) {
  _genericPicker = null;
  SP.popoverTarget = target;
  const cs = getColorState(target);
  const swatch = SP.panel.querySelector(`.color-swatch[data-target="${target}"]`);
  _showColorPopover(swatch, cs.hex, cs.opacity);
}

// Public API for non-SP callers (the position dialog). Pass the anchor
// element (= the swatch button), a starting hex / opacity, and a callback
// that fires every time the user picks a new color.
function openGenericColorPicker(anchor, hex, opacity, onChange) {
  _genericPicker = { anchor, cb: onChange, hex, opacity };
  // Seed the anchor swatch's bg so it reflects the current value.
  if (anchor) anchor.style.background = hexToRgba(hex, opacity);
  _showColorPopover(anchor, hex, opacity);
}

function hideColorPopover() {
  const pop = document.getElementById('sp-color-pop');
  if (pop) pop.classList.add('hidden');
  _genericPicker = null;
}

// Drag panel by its header
function makePanelDraggable(panel) {
  const header = panel.querySelector('header');
  if (!header) return;
  let dragging = false, startX, startY, startLeft, startTop;
  header.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;     // don't start drag on close button
    const rect = panel.getBoundingClientRect();
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    // Lock panel position via left/top, kill the centering transform
    panel.style.left = startLeft + 'px';
    panel.style.top  = startTop + 'px';
    panel.style.transform = 'none';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    panel.style.left = (startLeft + dx) + 'px';
    panel.style.top  = (startTop + dy) + 'px';
    // Hide popover during drag (its anchor is stale)
    hideColorPopover();
  });
  document.addEventListener('mouseup', () => {
    if (dragging) document.body.style.userSelect = '';
    dragging = false;
  });
}

function centerSettingsPanel() {
  // Reset to centered position (CSS default: left:50%; transform:translateX(-50%))
  SP.panel.style.left = '50%';
  SP.panel.style.top  = '80px';
  SP.panel.style.transform = 'translateX(-50%)';
}

// Document-level click handler — cascades close behavior across the nested
// popovers (save modal → template popover → color popover → settings panel).
// Clicking WAY outside all of them closes everything at once. Clicking inside
// the settings panel but outside a specific popover closes just that popover.
function installPanelOutsideClickHandler() {
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const panel = SP.panel;
    if (!panel || panel.classList.contains('hidden')) return;

    const modal = document.getElementById('tpl-save-modal');
    const tplPop = document.getElementById('sp-template-pop');
    const colorPop = document.getElementById('sp-color-pop');

    const modalOpen = modal && !modal.classList.contains('hidden');
    const tplOpen = tplPop && !tplPop.classList.contains('hidden');
    const colorOpen = colorPop && !colorPop.classList.contains('hidden');

    const modalContent = modal && modal.querySelector('.tpl-modal-content');
    const onModalContent = modalOpen && modalContent && modalContent.contains(e.target);
    const onTplPop  = tplOpen  && tplPop.contains(e.target);
    const onColorPop = colorOpen && colorPop.contains(e.target);
    const onPanel   = panel.contains(e.target);
    const onTplBtn  = document.getElementById('sp-template-btn')?.contains(e.target);
    const onSwatch  = !!e.target.closest('.color-swatch');

    const onAnything =
      onPanel || onModalContent || onTplPop || onColorPop || onTplBtn || onSwatch;

    if (!onAnything) {
      // Click outside every window → close everything
      hideSaveModal();
      hideTemplatePopover();
      hideColorPopover();
      cancelSettings();
      return;
    }

    // Click inside panel/popover hierarchy but outside a specific one → close that one
    if (modalOpen && !onModalContent) { hideSaveModal(); return; }
    if (tplOpen && !onTplPop && !onTplBtn) { hideTemplatePopover(); return; }
    if (colorOpen && !onColorPop && !onSwatch) { hideColorPopover(); return; }
  }, true);
}

// =================================================================
// Template storage + UI
// =================================================================
// Templates are bucketed by overlay type so a rectangle-with-fill template
// doesn't pollute the trendline picker.
const TEMPLATE_KEY = 'chart_viewer_drawing_templates_v2';

// Global drawing templates (shared across all layouts/symbols). Backend at
// user_data/templates.json is source of truth; localStorage is cache.
function _loadAll() {
  try { return JSON.parse(localStorage.getItem(TEMPLATE_KEY) || '{}'); }
  catch (e) { return {}; }
}
function _saveAll(all) {
  try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(all)); } catch (e) {}
  // Fire-and-forget to backend.
  try {
    fetch('/api/templates', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(all),
    });
  } catch (e) {}
}
// Sync cache from server at boot. If server has more templates than cache,
// adopt server's copy; if cache has entries server doesn't know about (first
// run after upgrade), push cache up.
async function _syncTemplatesFromServer() {
  let serverAll = null;
  try {
    const r = await fetch('/api/templates');
    if (r.ok) serverAll = await r.json();
  } catch (e) { /* offline → stay with cache */ }
  if (serverAll && typeof serverAll === 'object') {
    const cache = _loadAll();
    const serverKeys = Object.keys(serverAll);
    const cacheKeys = Object.keys(cache);
    // If server is empty but cache has stuff, push cache up.
    if (!serverKeys.length && cacheKeys.length) {
      try {
        await fetch('/api/templates', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cache),
        });
      } catch (e) {}
    } else if (serverKeys.length) {
      try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(serverAll)); } catch (e) {}
    }
  }
}
function currentOverlayBucket() {
  // Normalize to the 3 drawing families the user can have selected
  const ov = Drawing.selectedOverlay;
  if (!ov) return null;
  if (ov.name === 'path_snap') return 'path_done';      // same bucket
  return ov.name;   // trendline_snap / rectangle_snap / path_done
}
function getTemplates() {
  const bucket = currentOverlayBucket();
  if (!bucket) return [];
  const all = _loadAll();
  return Array.isArray(all[bucket]) ? all[bucket] : [];
}
function setTemplates(list) {
  const bucket = currentOverlayBucket();
  if (!bucket) return;
  const all = _loadAll();
  all[bucket] = list;
  _saveAll(all);
}

const DEFAULT_TEMPLATE = {
  color1: { hex: '#2962FF', opacity: 1 },
  color2: { hex: '#2962FF', opacity: 0.2 },
  size: 1,
  lineStyle: 'solid',
  text: { ...DEFAULT_TEXT_STATE, color: { ...DEFAULT_TEXT_STATE.color } },
};

function snapshotPanelAsTemplate() {
  const st = readPanelState();
  const snap = {
    color1: { ...st.color1 },
    color2: { ...st.color2 },
    size: st.size,
    lineStyle: st.lineStyle,
  };
  // Persist text settings (incl. content) for rectangle and trendline templates.
  const bucket = currentOverlayBucket();
  if (bucket === 'rectangle_snap' || bucket === 'trendline_snap') {
    snap.text = { ...st.text, color: { ...st.text.color } };
  }
  return snap;
}

function applyTemplateToPanel(tpl) {
  SP.colors['1'] = { ...tpl.color1 };
  SP.colors['2'] = { ...tpl.color2 };
  const sw1 = SP.panel.querySelector('.color-swatch[data-target="1"]');
  const sw2 = SP.panel.querySelector('.color-swatch[data-target="2"]');
  if (sw1) sw1.style.background = hexToRgba(tpl.color1.hex, tpl.color1.opacity);
  if (sw2) sw2.style.background = hexToRgba(tpl.color2.hex, tpl.color2.opacity);
  SP.panel.querySelectorAll('.th-btn').forEach(b => {
    b.classList.toggle('active', +b.dataset.size === tpl.size);
  });
  SP.panel.querySelectorAll('.ls-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.style === tpl.lineStyle);
  });
  if (tpl.text) loadTextIntoPanel(tpl.text);
  applyLive();
}

function showTemplatePopover() {
  const pop = document.getElementById('sp-template-pop');
  const btn = document.getElementById('sp-template-btn');
  if (!pop || !btn) return;
  renderTemplateList();
  pop.classList.remove('hidden');
  // Position above the button (footer), aligned to its left edge
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let top = r.top - h - 4;
  if (top < 5) top = r.bottom + 4;   // flip down if too tall
  let left = r.left;
  if (left + w > window.innerWidth - 5) left = window.innerWidth - w - 5;
  pop.style.left = Math.max(5, left) + 'px';
  pop.style.top = top + 'px';
}
function hideTemplatePopover() {
  const pop = document.getElementById('sp-template-pop');
  if (pop) pop.classList.add('hidden');
}
function renderTemplateList() {
  const list = document.getElementById('sp-template-list');
  if (!list) return;
  list.innerHTML = '';
  const tpls = getTemplates();
  if (!tpls.length) {
    const e = document.createElement('div');
    e.className = 'tpl-empty';
    e.textContent = (window.I18n && window.I18n.t)
      ? window.I18n.t('panel.drawing.tplEmptySaved')
      : '（尚無儲存的模板）';
    list.appendChild(e);
    return;
  }
  const delLabel = (window.I18n && window.I18n.t)
    ? window.I18n.t('panel.drawing.tplDelete')
    : '刪除';
  for (const t of tpls) {
    const row = document.createElement('div');
    row.className = 'tpl-item';
    row.innerHTML = `<span class="tpl-name">${t.name}</span><span class="tpl-del" title="${delLabel}">✕</span>`;
    // Entire row (except the X) applies the template
    row.addEventListener('click', (e) => {
      if (e.target.closest('.tpl-del')) return;
      applyTemplateToPanel(t);
      hideTemplatePopover();
    });
    row.querySelector('.tpl-del').addEventListener('click', (e) => {
      e.stopPropagation();
      const all = getTemplates().filter(x => x.name !== t.name);
      setTemplates(all);
      renderTemplateList();
    });
    list.appendChild(row);
  }
}

function showSaveModal() {
  const modal = document.getElementById('tpl-save-modal');
  if (!modal) return;
  const input = document.getElementById('tpl-name-input');
  const confirmBtn = document.getElementById('tpl-save-confirm');
  input.value = '';
  confirmBtn.disabled = true;
  document.getElementById('tpl-name-existing').classList.add('hidden');
  modal.classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}
function hideSaveModal() {
  const modal = document.getElementById('tpl-save-modal');
  if (modal) modal.classList.add('hidden');
}
function renderExistingNamesInModal() {
  const wrap = document.getElementById('tpl-name-existing');
  const input = document.getElementById('tpl-name-input');
  if (!wrap) return;
  const tpls = getTemplates();
  wrap.innerHTML = '';
  if (!tpls.length) {
    const e = document.createElement('div');
    e.className = 'tpl-empty';
    e.textContent = (window.I18n && window.I18n.t)
      ? window.I18n.t('panel.drawing.tplEmpty')
      : '（尚無模板）';
    wrap.appendChild(e);
  } else {
    for (const t of tpls) {
      const row = document.createElement('div');
      row.className = 'tpl-item';
      row.textContent = t.name;
      row.addEventListener('click', () => {
        input.value = t.name;
        document.getElementById('tpl-save-confirm').disabled = !t.name;
        wrap.classList.add('hidden');
      });
      wrap.appendChild(row);
    }
  }
  wrap.classList.remove('hidden');
}

function initTemplateSystem() {
  const tplBtn = document.getElementById('sp-template-btn');
  if (!tplBtn) return;

  // Toggle template popover
  tplBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = document.getElementById('sp-template-pop');
    if (pop.classList.contains('hidden')) showTemplatePopover();
    else hideTemplatePopover();
  });

  // Popover actions
  document.querySelectorAll('#sp-template-pop .tpl-action').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = item.dataset.act;
      if (act === 'save-as') {
        hideTemplatePopover();
        showSaveModal();
      } else if (act === 'apply-defaults') {
        applyTemplateToPanel(DEFAULT_TEMPLATE);
        hideTemplatePopover();
      }
    });
  });

  // Save modal buttons
  document.getElementById('tpl-save-close').addEventListener('click', hideSaveModal);
  document.getElementById('tpl-save-cancel').addEventListener('click', hideSaveModal);
  document.getElementById('tpl-name-input').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    document.getElementById('tpl-save-confirm').disabled = !v;
    const existing = document.getElementById('tpl-name-existing');
    if (existing) existing.classList.add('hidden');
  });
  document.getElementById('tpl-name-dropdown-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.getElementById('tpl-name-existing');
    if (existing.classList.contains('hidden')) renderExistingNamesInModal();
    else existing.classList.add('hidden');
  });
  document.getElementById('tpl-save-confirm').addEventListener('click', () => {
    const name = document.getElementById('tpl-name-input').value.trim();
    if (!name) return;
    const snap = snapshotPanelAsTemplate();
    const list = getTemplates();
    const idx = list.findIndex(t => t.name === name);
    const entry = { name, ...snap };
    if (idx >= 0) list[idx] = entry;   // overwrite
    else list.push(entry);
    setTemplates(list);
    hideSaveModal();
  });
  // Enter in input = save
  document.getElementById('tpl-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !document.getElementById('tpl-save-confirm').disabled) {
      document.getElementById('tpl-save-confirm').click();
    } else if (e.key === 'Escape') {
      hideSaveModal();
    }
  });
}

function showSettings(overlay, titleText) {
  if (!overlay || !Drawing.chart) return;
  // Position overlays use a dedicated dialog (different field schema —
  // account size / lot size / risk / Ticks↔price coupling / qty precision)
  // that doesn't share controls with the trendline/rect/measure panel.
  if (overlay.name === 'long_position' || overlay.name === 'short_position') {
    Drawing.selectedOverlay = overlay;
    if (window.PositionOverlaySettings) {
      window.PositionOverlaySettings.open(overlay);
    }
    return;
  }
  // Fibo overlays — 3-tab popover (style / coords / visibility) with
  // 11+ enabled levels, per-level color, background fill, reverse,
  // single-color override. Schema is too different from the
  // trendline/rect/measure panel to share controls.
  if (overlay.name === 'fibo_retrace' || overlay.name === 'fibo_extension' || overlay.name === 'fibo_time') {
    Drawing.selectedOverlay = overlay;
    if (window.FiboSettings) {
      window.FiboSettings.open(overlay);
    }
    return;
  }
  Drawing.selectedOverlay = overlay;
  document.getElementById('sp-title').textContent = titleText || getOverlayDisplayName(overlay);

  // Save original for cancel revert
  SP.originalState = {
    styles: overlay.styles ? JSON.parse(JSON.stringify(overlay.styles)) : null,
    visible: overlay.visible !== false,
    lock: !!overlay.lock,
    extendData: overlay.extendData ? JSON.parse(JSON.stringify(overlay.extendData)) : null,
  };

  // Show/hide the 文字 tab — rectangle, trendline, and measure all have text labels.
  const isRect = overlay.name === 'rectangle_snap';
  const isTrend = overlay.name === 'trendline_snap';
  const isMeasure = overlay.name === 'measure_snap';
  const isTextBox = isRect && !!(overlay.extendData && overlay.extendData.textBox);
  const hasText = isRect || isTrend || isMeasure;
  SP.panel.querySelector('.tab[data-tab="text"]').classList.toggle('hidden', !hasText);
  // A text box's background/border live on the 文字 tab (not the shared rect
  // fill/border), so hide the 樣式 tab and the textbox-only rows accordingly.
  const styleTab = SP.panel.querySelector('.tab[data-tab="style"]');
  if (styleTab) styleTab.classList.toggle('hidden', isTextBox);
  SP.panel.querySelectorAll('.sp-textbox-only').forEach(el => el.classList.toggle('hidden', !isTextBox));
  if (isTextBox) {
    const ed = overlay.extendData || {};
    const bgCb = document.getElementById('sp-textbox-bg-enabled');
    const bdCb = document.getElementById('sp-textbox-border-enabled');
    const wrapCb = document.getElementById('sp-textbox-wrap');
    if (bgCb)   bgCb.checked = !!ed.bgEnabled;
    if (bdCb)   bdCb.checked = !!ed.borderEnabled;
    if (wrapCb) wrapCb.checked = !!ed.wrap;
    // Seed the two swatches (they share the generic openColorPopover machinery,
    // keyed by SP.colors[target]).
    const bgC = ed.bgColor || { hex: '#1e222d', opacity: 0.85 };
    const bdC = ed.borderColor || { hex: '#2962ff', opacity: 1 };
    SP.colors['textbox-bg'] = { ...bgC };
    SP.colors['textbox-border'] = { ...bdC };
    const swBg = SP.panel.querySelector('.color-swatch[data-target="textbox-bg"]');
    const swBd = SP.panel.querySelector('.color-swatch[data-target="textbox-border"]');
    if (swBg) swBg.style.background = hexToRgba(bgC.hex, bgC.opacity);
    if (swBd) swBd.style.background = hexToRgba(bdC.hex, bdC.opacity);
  }
  // Hide text-alignment row for measure — text always sits centered on the
  // horizontal crosshair, no vPos / hAlign choice.
  const vposRow = document.getElementById('sp-text-vpos');
  if (vposRow && vposRow.closest('.row')) {
    vposRow.closest('.row').classList.toggle('hidden', isMeasure);
  }
  // Show/hide the measure-only 框線 toggle row.
  const borderRow = document.getElementById('sp-row-border-toggle');
  if (borderRow) borderRow.classList.toggle('hidden', !isMeasure);
  const borderCb = document.getElementById('sp-border-enabled');
  if (borderCb) {
    borderCb.checked = !!(overlay.extendData && overlay.extendData.borderEnabled);
  }
  // Border swatch is muted/disabled when the checkbox is off so the user
  // can still see the chosen color but understands it's inactive.
  _syncBorderSwatchDisabled();
  // Swap vPos option labels based on overlay type (values stay the same).
  // Spec i18n §3.7 — rect uses Top/Middle/Bottom; trendline+measure
  // use Above/Middle/Below (different vertical-alignment vocabulary).
  const vPosSel = document.getElementById('sp-text-vpos');
  if (vPosSel && hasText) {
    const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
    if (isRect) {
      vPosSel.options[0].textContent = t_('panel.drawing.alignTop');
      vPosSel.options[1].textContent = t_('panel.drawing.alignInside');
      vPosSel.options[2].textContent = t_('panel.drawing.alignBottom');
    } else {
      vPosSel.options[0].textContent = t_('panel.drawing.alignAbove');
      vPosSel.options[1].textContent = t_('panel.drawing.alignMiddleH');
      vPosSel.options[2].textContent = t_('panel.drawing.alignBelow');
    }
  }

  // Curve-only: end arrows + tangent extensions (extendData.curve). Toggle the
  // rows' visibility every open so they never leak onto a line/rect/measure.
  const isCurve = overlay.name === 'curve_snap';
  document.getElementById('sp-row-curve-arrow').classList.toggle('hidden', !isCurve);
  document.getElementById('sp-row-curve-extend').classList.toggle('hidden', !isCurve);
  if (isCurve) {
    const cd = (overlay.extendData && overlay.extendData.curve) || {};
    document.getElementById('sp-curve-arrow-left').classList.toggle('active', !!cd.arrowLeft);
    document.getElementById('sp-curve-arrow-right').classList.toggle('active', !!cd.arrowRight);
    document.getElementById('sp-curve-extend-left').classList.toggle('active', !!cd.extendLeft);
    document.getElementById('sp-curve-extend-right').classList.toggle('active', !!cd.extendRight);
  }

  // Populate panel from current overlay state
  loadStateIntoPanel(overlay);

  // Reset to first (visible) tab
  const tabs = [...SP.panel.querySelectorAll('.tab')];
  tabs.forEach(t => t.classList.remove('active'));
  const firstTab = tabs.find(t => !t.classList.contains('hidden')) || tabs[0];
  if (firstTab) firstTab.classList.add('active');
  SP.panel.querySelectorAll('.tab-body').forEach(b => {
    b.classList.toggle('hidden', b.dataset.tab !== (firstTab && firstTab.dataset.tab));
  });
  hideColorPopover();

  // Show panel + re-center each open
  SP.panel.classList.remove('hidden');
  centerSettingsPanel();
}

function hideSettings() {
  SP.panel.classList.add('hidden');
  hideColorPopover();
  hideTemplatePopover();
  hideSaveModal();
}

function cancelSettings() {
  // Revert to snapshot. applyLive already mirrored the live preview into the
  // registry (main or _miniRegistry), so cancel must revert BOTH the chart the
  // overlay lives on AND its registry entry — route via _chartOf /
  // updateTrackedOverlay so a mini overlay reverts on the mini, not the main.
  if (SP.originalState && Drawing.selectedOverlay && Drawing.chart) {
    const id = Drawing.selectedOverlay.id;
    const revert = {
      styles: SP.originalState.styles,
      visible: SP.originalState.visible,
      lock: SP.originalState.lock,
      extendData: SP.originalState.extendData,
    };
    _chartOf(id).overrideOverlay({ id, ...revert });
    Drawing.selectedOverlay.extendData = SP.originalState.extendData;
    updateTrackedOverlay(id, revert);
  }
  SP.originalState = null;
  hideSettings();
}

function confirmSettings() {
  // Live preview is already on the overlay; just close.
  // Push undo entry capturing the before-state (SP.originalState) and
  // the after-state (current overlay's styles + extendData + lock +
  // visible). Skip if no overlay selected or nothing changed.
  const ov = Drawing.selectedOverlay;
  const before = SP.originalState;
  if (ov && before) {
    const after = {
      styles: ov.styles ? JSON.parse(JSON.stringify(ov.styles)) : null,
      visible: ov.visible !== false,
      lock: !!ov.lock,
      extendData: ov.extendData ? JSON.parse(JSON.stringify(ov.extendData)) : null,
    };
    const beforeFrozen = {
      styles: before.styles ? JSON.parse(JSON.stringify(before.styles)) : null,
      visible: before.visible !== false,
      lock: !!before.lock,
      extendData: before.extendData ? JSON.parse(JSON.stringify(before.extendData)) : null,
    };
    const changed = JSON.stringify(beforeFrozen) !== JSON.stringify(after);
    if (changed) {
      const id = ov.id;
      pushUndo({
        label: 'Edit overlay style',
        undo: () => {
          try { _chartOf(id).overrideOverlay({ id, ...beforeFrozen }); } catch (e) {}
          updateTrackedOverlay(id, beforeFrozen);
          if (Drawing.selectedOverlay && Drawing.selectedOverlay.id === id) {
            Object.assign(Drawing.selectedOverlay, beforeFrozen);
          }
        },
        redo: () => {
          try { _chartOf(id).overrideOverlay({ id, ...after }); } catch (e) {}
          updateTrackedOverlay(id, after);
          if (Drawing.selectedOverlay && Drawing.selectedOverlay.id === id) {
            Object.assign(Drawing.selectedOverlay, after);
          }
        },
      });
    }
  }
  SP.originalState = null;
  hideSettings();
}

// Read panel control state → unified style spec
function readPanelState() {
  const sizeBtn = SP.panel.querySelector('.th-btn.active');
  const size = sizeBtn ? +sizeBtn.dataset.size : 1;
  const styleBtn = SP.panel.querySelector('.ls-btn.active');
  const lineStyle = styleBtn ? styleBtn.dataset.style : 'solid';
  const visible = document.getElementById('sp-visible').checked;
  const locked = document.getElementById('sp-locked').checked;
  return {
    color1: getColorState('1'),
    color2: getColorState('2'),
    size, lineStyle, visible, locked,
    text: readTextPanelState(),
  };
}

function readTextPanelState() {
  return {
    content: document.getElementById('sp-text-content').value || '',
    size: parseInt(document.getElementById('sp-text-size').value, 10) || 20,
    bold: document.getElementById('sp-text-bold').classList.contains('active'),
    italic: document.getElementById('sp-text-italic').classList.contains('active'),
    color: { ...getColorState('text') },
    vPos: document.getElementById('sp-text-vpos').value || 'inside',
    hAlign: document.getElementById('sp-text-halign').value || 'center',
  };
}

function loadTextIntoPanel(text, defaultColor) {
  // `defaultColor` lets the caller override the factory-default text color
  // when the overlay has no saved text.color yet. Used by measure_snap so a
  // new measure's text defaults to the crosshair color.
  const base = defaultColor
    ? { ...DEFAULT_TEXT_STATE, color: { ...defaultColor } }
    : DEFAULT_TEXT_STATE;
  const t = { ...base, ...(text || {}) };
  document.getElementById('sp-text-content').value = t.content || '';
  document.getElementById('sp-text-size').value = String(t.size);
  document.getElementById('sp-text-bold').classList.toggle('active', !!t.bold);
  document.getElementById('sp-text-italic').classList.toggle('active', !!t.italic);
  document.getElementById('sp-text-vpos').value = t.vPos;
  document.getElementById('sp-text-halign').value = t.hAlign;
  SP.colors['text'] = { ...t.color };
  const sw = SP.panel.querySelector('.color-swatch[data-target="text"]');
  if (sw) sw.style.background = hexToRgba(t.color.hex, t.color.opacity);
}

// Map panel state → KLineChart styles object for the given overlay type
// Keep the 框線 color swatch visually muted when the checkbox is off.
function _syncBorderSwatchDisabled() {
  const cb = document.getElementById('sp-border-enabled');
  const sw = SP.panel && SP.panel.querySelector('.color-swatch[data-target="3"]');
  if (!cb || !sw) return;
  sw.classList.toggle('disabled', !cb.checked);
}

function computeStyles(overlayName, st) {
  if (overlayName === 'rectangle_snap') {
    const border = hexToRgba(st.color1.hex, st.color1.opacity);
    const fill   = hexToRgba(st.color2.hex, st.color2.opacity);
    const preset = LINE_STYLE_PRESETS[st.lineStyle] || LINE_STYLE_PRESETS.solid;
    return {
      rect: {
        style: 'stroke_fill',
        color: fill,
        borderColor: border,
        borderSize: st.size,
        borderStyle: preset.style,
        borderDashedValue: preset.dashedValue,
      },
      point: { color: st.color1.hex, borderColor: '#fff', borderSize: 1, radius: 4 },
    };
  }
  if (overlayName === 'measure_snap') {
    // color1 = crosshair (lines + arrows), color2 = rect background fill,
    // color3 = border color. Border visibility is toggled separately via
    // extendData.borderEnabled; the color value is always stored so the
    // swatch remembers the user's choice when the checkbox is re-enabled.
    const crosshairRgba = hexToRgba(st.color1.hex, st.color1.opacity);
    const bgRgba = hexToRgba(st.color2.hex, st.color2.opacity);
    const color3 = SP.colors['3'] || { hex: '#2962FF', opacity: 1 };
    const borderRgba = hexToRgba(color3.hex, color3.opacity);
    return {
      crosshair: { color: crosshairRgba, size: st.size },
      rect:      { color: bgRgba, borderColor: borderRgba, borderSize: Math.max(1, st.size) },
      label:     { bg: 'rgba(30,34,45,0.92)', text: '#d1d4dc', fontSize: 13 },
      point:     { color: st.color1.hex, borderColor: '#fff', borderSize: 1, radius: 4 },
    };
  }
  // line-based overlays (trendline_snap, path_snap, path_done)
  const preset = LINE_STYLE_PRESETS[st.lineStyle] || LINE_STYLE_PRESETS.solid;
  return {
    line: {
      color: hexToRgba(st.color1.hex, st.color1.opacity),
      size: st.size,
      style: preset.style,
      dashedValue: preset.dashedValue,
    },
    point: { color: st.color1.hex, borderColor: '#fff', borderSize: 1, radius: 4 },
  };
}

function applyLive() {
  const ov = Drawing.selectedOverlay;
  if (!ov || !Drawing.chart) return;
  const st = readPanelState();
  const styles = computeStyles(ov.name, st);
  const patch = { id: ov.id, styles, visible: st.visible, lock: st.locked };
  // Text state is stored on extendData so createPointFigures can read it.
  // Rectangles, trendlines, and measure_snap all support text labels.
  if (ov.name === 'rectangle_snap' || ov.name === 'trendline_snap' || ov.name === 'measure_snap') {
    patch.extendData = { ...(ov.extendData || {}), text: st.text };
    if (ov.name === 'measure_snap') {
      // Read the 框線 checkbox into extendData so createPointFigures picks it up.
      const cb = document.getElementById('sp-border-enabled');
      patch.extendData.borderEnabled = !!(cb && cb.checked);
    }
    // Text box: its background/border/wrap live on extendData (not the shared
    // rect fill/border styles).
    if (patch.extendData.textBox) {
      const bgCb = document.getElementById('sp-textbox-bg-enabled');
      const bdCb = document.getElementById('sp-textbox-border-enabled');
      const wrapCb = document.getElementById('sp-textbox-wrap');
      const prevWrap = !!patch.extendData.wrap;
      patch.extendData.bgEnabled = !!(bgCb && bgCb.checked);
      patch.extendData.borderEnabled = !!(bdCb && bdCb.checked);
      patch.extendData.wrap = !!(wrapCb && wrapCb.checked);
      patch.extendData.bgColor = SP.colors['textbox-bg'] || patch.extendData.bgColor;
      patch.extendData.borderColor = SP.colors['textbox-border'] || patch.extendData.borderColor;
      ov.extendData = patch.extendData;
      _chartOf(ov.id).overrideOverlay(patch);
      ov.visible = st.visible; ov.lock = st.locked; ov.styles = styles;
      updateTrackedOverlay(ov.id, { visible: st.visible, lock: st.locked, styles, extendData: patch.extendData });
      // Toggling wrap changes the box geometry (fixed-width vs auto-grow).
      if (prevWrap !== patch.extendData.wrap) _autoSizeTextBox(Drawing.overlayRegistry.get(ov.id) || ov);
      captureInheritedStyle(ov.name, styles, ov.extendData);
      return;
    }
    ov.extendData = patch.extendData;
  } else if (ov.name === 'curve_snap') {
    const on = (id) => { const b = document.getElementById(id); return !!(b && b.classList.contains('active')); };
    patch.extendData = {
      ...(ov.extendData || {}),
      curve: {
        arrowLeft: on('sp-curve-arrow-left'), arrowRight: on('sp-curve-arrow-right'),
        extendLeft: on('sp-curve-extend-left'), extendRight: on('sp-curve-extend-right'),
      },
    };
    ov.extendData = patch.extendData;
  }
  _chartOf(ov.id).overrideOverlay(patch);
  ov.visible = st.visible;
  ov.lock = st.locked;
  ov.styles = styles;
  // Mirror changes into the registry so persistence picks them up.
  updateTrackedOverlay(ov.id, {
    visible: st.visible, lock: st.locked, styles,
    ...(patch.extendData ? { extendData: patch.extendData } : {}),
  });
  // Remember these settings so the next-drawn shape of the same type
  // inherits them (text content stripped).
  captureInheritedStyle(ov.name, styles, ov.extendData);
}

// Read overlay's current style → set panel controls
function loadStateIntoPanel(ov) {
  const isRect = ov.name === 'rectangle_snap';
  const isMeasure = ov.name === 'measure_snap';
  const styles = ov.styles || {};

  let size = 1, lineStyleKey = 'solid';
  let color1, color2;

  if (isRect) {
    const r = styles.rect || {};
    color1 = parseColor(r.borderColor || '#2962FF');
    color2 = parseColor(r.color || 'rgba(41,98,255,0.2)');
    size   = r.borderSize || 1;
    // Detect line-style from border style/dash
    lineStyleKey = detectLineStyleKey({ style: r.borderStyle, dashedValue: r.borderDashedValue });
  } else if (isMeasure) {
    const cs = styles.crosshair || {};
    const r  = styles.rect || {};
    color1 = parseColor(cs.color || '#2962FF');
    color2 = parseColor(r.color || 'rgba(41,98,255,0.12)');
    const color3 = parseColor(r.borderColor || '#2962FF');
    SP.colors['3'] = color3;
    const sw3 = SP.panel.querySelector('.color-swatch[data-target="3"]');
    if (sw3) sw3.style.background = hexToRgba(color3.hex, color3.opacity);
    size   = cs.size || 1;
    lineStyleKey = 'solid';  // measure crosshair is always solid for now
  } else {
    const l = styles.line || {};
    color1 = parseColor(l.color || '#2962FF');
    color2 = { hex: '#2962FF', opacity: 0.2 };
    size = l.size || 1;
    lineStyleKey = detectLineStyleKey(l);
  }

  // Sync state objects (so sliders/swatches don't show stale values)
  SP.colors['1'] = color1;
  SP.colors['2'] = color2;

  // Update swatch UIs
  const sw1 = SP.panel.querySelector('.color-swatch[data-target="1"]');
  const sw2 = SP.panel.querySelector('.color-swatch[data-target="2"]');
  if (sw1) sw1.style.background = hexToRgba(color1.hex, color1.opacity);
  if (sw2) sw2.style.background = hexToRgba(color2.hex, color2.opacity);

  // Show/hide rows by overlay type
  const hasColor2Row = isRect || isMeasure;
  document.getElementById('sp-row-color2').classList.toggle('hidden', !hasColor2Row);
  // Line-style row applies to lines (line.style) and rectangles (rect.borderStyle).
  // Measure's crosshair is always solid → hide the row.
  document.getElementById('sp-row-linestyle').classList.toggle('hidden', isMeasure);
  // color1 label follows overlay type — measure uses crosshair color,
  // rectangle uses border, others use generic color.
  const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
  document.getElementById('sp-color1-label').textContent = isMeasure
    ? t_('panel.drawing.crosshair')
    : (isRect ? t_('panel.drawing.borderToggle') : t_('panel.drawing.color'));

  // Thickness + line style buttons
  SP.panel.querySelectorAll('.th-btn').forEach(b => {
    b.classList.toggle('active', +b.dataset.size === size);
  });
  SP.panel.querySelectorAll('.ls-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.style === lineStyleKey);
  });

  document.getElementById('sp-visible').checked = ov.visible !== false;
  document.getElementById('sp-locked').checked = !!ov.lock;

  if (isRect || ov.name === 'trendline_snap' || isMeasure) {
    const storedText = (ov.extendData && ov.extendData.text) || null;
    // For measure: seed the text tab's color with the crosshair color when
    // there's nothing saved yet, so the user's first-typed text matches the
    // line color without them having to open the color picker.
    loadTextIntoPanel(storedText, isMeasure ? color1 : null);
  }
}

// ----- Color helpers -----
function hexToRgba(hex, a) {
  if (!hex) return `rgba(41,98,255,${a})`;
  if (hex.startsWith('rgb')) return hex;     // already rgba
  const m = hex.replace('#', '');
  const n = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${a})`;
}

function parseColor(c) {
  if (!c) return { hex: '#2962FF', opacity: 1 };
  if (c.startsWith('#')) return { hex: c.toUpperCase(), opacity: 1 };
  const m = c.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/);
  if (!m) return { hex: '#2962FF', opacity: 1 };
  const r = +m[1], g = +m[2], b = +m[3], a = m[4] != null ? +m[4] : 1;
  const hex = '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { hex, opacity: a };
}

// =================================================================
// Object tree panel — lists indicators + drawings with visibility / delete
// =================================================================
function initObjectTree(chart) {
  const panel = document.getElementById('obj-tree');
  if (!panel) return;

  const btn = document.getElementById('btn-obj-tree');
  const closeBtn = document.getElementById('obj-tree-close');
  const clearBtn = document.getElementById('obj-tree-clear');

  btn.addEventListener('click', () => {
    const hidden = panel.classList.toggle('hidden');
    btn.classList.toggle('active', !hidden);
    if (!hidden) refreshObjectTree();
  });
  closeBtn.addEventListener('click', () => {
    panel.classList.add('hidden');
    btn.classList.remove('active');
  });
  clearBtn.addEventListener('click', () => {
    const msg = (window.I18n && window.I18n.t)
      ? window.I18n.t('dlg.confirmClearAllExtra')
      : '清除所有繪圖？（不影響指標）';
    if (!confirm(msg)) return;
    // Snapshot every overlay BEFORE removing — undo recreates them
    // all in one Ctrl+Z. Order doesn't matter for the restored set
    // (overlay z-order isn't preserved across recreate anyway).
    const snaps = [];
    for (const e of Drawing.overlayRegistry.values()) {
      const snap = _fullOverlaySnapshot(e);
      if (snap) snaps.push(snap);
    }
    chart.removeOverlay();
    Drawing.overlayRegistry.clear();
    Drawing.selectedOverlay = null;
    refreshObjectTree();
    schedulePersist();
    if (snaps.length) {
      const refs = snaps.map(s => ({ id: null, snap: s }));
      pushUndo({
        label: 'Clear all drawings',
        undo: () => {
          for (const r of refs) {
            const newId = _recreateFromSnapshot(r.snap);
            r.id = newId || null;
          }
          refreshObjectTree();
        },
        redo: () => {
          for (const r of refs) {
            if (r.id) try { chart.removeOverlay({ id: r.id }); } catch (e) {}
          }
          Drawing.overlayRegistry.clear();
          Drawing.selectedOverlay = null;
          refreshObjectTree();
        },
      });
    }
  });
}

const SVG_EYE_ON  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const SVG_EYE_OFF = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-6.5 0-10-7-10-7a17.75 17.75 0 0 1 4.06-5.19"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a17.5 17.5 0 0 1-2.17 3.16"/><line x1="3" y1="3" x2="21" y2="21"/></svg>';
const SVG_TRASH   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const SVG_DRAW_ICONS = {
  trendline_snap: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="4" y1="20" x2="20" y2="4"/></svg>',
  rectangle_snap: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="6" width="16" height="12"/></svg>',
  path_snap:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 18 9 10 14 14 21 4"/></svg>',
  path_done:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 18 9 10 14 14 21 4"/></svg>',
  text_box:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 7 H19"/><path d="M12 7 V18"/></svg>',
  _default:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/></svg>',
};
const SVG_IND_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="3" y1="20" x2="3" y2="4"/><rect x="6" y="10" width="3" height="10" fill="currentColor"/><rect x="12" y="14" width="3" height="6" fill="currentColor"/><rect x="18" y="6" width="3" height="14" fill="currentColor"/></svg>';
const SVG_CHART_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="7" width="4" height="14"/></svg>';

function refreshObjectTree() {
  const list = document.getElementById('obj-tree-list');
  if (!list || !Drawing.chart) return;
  const panel = document.getElementById('obj-tree');
  if (panel && panel.classList.contains('hidden')) return;   // not visible, skip

  list.innerHTML = '';

  // Header: symbol + TF
  const headRow = document.createElement('div');
  headRow.className = 'obj-row header-row';
  const tfLabel = (window.App && window.App.currentTF) || '';
  headRow.innerHTML = `
    <span class="obj-icon">${SVG_CHART_ICON}</span>
    <span class="obj-name">NQ1! · CME, ${tfLabel}</span>
  `;
  list.appendChild(headRow);

  // Indicators (VOL pane etc.)
  const indicators = (Drawing.chart.getIndicators && Drawing.chart.getIndicators()) || [];
  const indList = Array.isArray(indicators) ? indicators : Object.values(indicators).flat();
  for (const ind of indList) {
    if (!ind) continue;
    list.appendChild(makeIndicatorRow(ind));
  }

  // Overlays — merge registry (source of truth) with chart.getOverlays() if
  // present (catches overlays created outside our wrappers, e.g. hot reload)
  const byId = new Map(Drawing.overlayRegistry);
  const fromChart = (Drawing.chart.getOverlays && Drawing.chart.getOverlays()) || [];
  for (const ov of fromChart) {
    if (!byId.has(ov.id)) byId.set(ov.id, {
      id: ov.id, name: ov.name, visible: ov.visible !== false,
      lock: !!ov.lock, styles: ov.styles, points: ov.points,
    });
  }
  const overlays = Array.from(byId.values());
  const sortedOverlays = overlays.sort((a, b) => {
    const ta = a.points?.[0]?.timestamp || 0;
    const tb = b.points?.[0]?.timestamp || 0;
    return tb - ta;         // newest first
  });
  // Mini (sub-chart) overlays live in a SEPARATE registry. List them too so the
  // object tree shows "all objects" — each keeps its branch badge, and a 副圖
  // group label separates them. Empty/incomplete entries (no points) skipped.
  const miniEntries = Drawing._miniRegistry
    ? [...Drawing._miniRegistry.values()].filter(e => e && e.points && e.points.length >= 2)
        .sort((a, b) => (b.points[0]?.timestamp || 0) - (a.points[0]?.timestamp || 0))
    : [];

  if (!sortedOverlays.length && !indList.length && !miniEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'obj-empty';
    empty.textContent = (window.I18n && window.I18n.t)
      ? window.I18n.t('panel.objectTree.empty')
      : '（尚無繪圖或指標）';
    list.appendChild(empty);
    return;
  }
  for (const ov of sortedOverlays) {
    list.appendChild(makeOverlayRow(ov, 'main'));
  }
  if (miniEntries.length) {
    const label = document.createElement('div');
    label.className = 'obj-tree-group-label';
    label.textContent = (window.I18n && window.I18n.lang === 'en') ? 'Sub-chart' : '副圖物件';
    list.appendChild(label);
    for (const e of miniEntries) list.appendChild(makeOverlayRow(e, 'mini'));
  }
}

// Branch-kind colors — mirror branch_panel.js KIND_COLORS so the object-tree
// badge matches the branch panel's dots.
const BRANCH_KIND_COLORS = {
  main: '#5a6478', exec: '#089981', direction: '#ef5350',
  sandbox: '#7d6cbf', archived: '#3a3f4b',
};
// Escape user-provided text (branch names are user-renamable) before it goes
// into innerHTML — covers both text nodes and double-quoted attributes.
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Format an overlay's creation timestamp for the object-tree row tooltip, in the
// chart's display timezone (ET) so it matches the x-axis. e.g. "2023-05-11 06:00 ET".
function _fmtOverlayTime(ts) {
  if (!Number.isFinite(ts)) return '';
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(ts)).reduce((o, x) => (o[x.type] = x.value, o), {});
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ET`;
  } catch (e) { return new Date(ts).toISOString(); }
}

// Resolve the branch an overlay belongs to → { name, color } for its badge.
// null / 'main' branchId → 主線 (the drawing lives on the main timeline).
function _overlayBranchBadge(branchId) {
  const BE = window.BranchEngine;
  const id = branchId || 'main';
  const b = BE && BE.getBranch ? BE.getBranch(id) : null;
  const kind = b ? (b.kind || 'exec') : 'main';
  let name;
  if (b && b.name) name = b.name;
  else if (id === 'main') name = (window.I18n && window.I18n.t) ? window.I18n.t('branch.kindMain') : '主線';
  else name = id;   // branch was deleted but overlay still tagged — show the id
  return { name, color: BRANCH_KIND_COLORS[kind] || BRANCH_KIND_COLORS.main };
}

// Select a MINI overlay from a tree row: open the mini for its branch (which
// makes it live + assigns _ovid via renderMiniBranchOverlays), then select it.
function selectMiniOverlayFromTree(entry) {
  _ensureMiniOpenForBranch(entry.branchId);
  refreshObjectTree();                      // rows now carry the live _ovid
  if (entry._ovid) selectOverlayFromTree(entry._ovid);
}

// host: 'main' → `ov` is an overlayRegistry entry (id = ov.id); 'mini' → `ov` is
// a _miniRegistry entry (live id = ov._ovid, null while the mini is closed).
function makeOverlayRow(ov, host) {
  host = host || 'main';
  const isMini = host === 'mini';
  const id = isMini ? ov._ovid : ov.id;

  const row = document.createElement('div');
  row.className = 'obj-row' + (isMini ? ' is-mini' : '');
  if (id) row.dataset.overlayId = id;
  row.dataset.host = host;
  if (isMini && ov.key) row.dataset.miniKey = ov.key;
  if (ov.visible === false) row.classList.add('disabled');
  // Persist the selected highlight across refreshObjectTree rebuilds.
  if (id && Drawing.selectedOverlay && Drawing.selectedOverlay.id === id) row.classList.add('selected');
  // Hover tooltip → the timestamp the object was created at (ET, matches the axis).
  const _t0 = ov.points && ov.points[0] && ov.points[0].timestamp;
  if (Number.isFinite(_t0)) row.title = _fmtOverlayTime(_t0);

  const isTextBoxRow = ov.name === 'rectangle_snap' && ov.extendData && ov.extendData.textBox;
  const icon = (isTextBoxRow ? SVG_DRAW_ICONS.text_box : SVG_DRAW_ICONS[ov.name]) || SVG_DRAW_ICONS._default;
  const name = getOverlayDisplayName(ov);
  const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
  const eyeTitle = ov.visible === false ? t_('common.show') : t_('common.hide');
  const removeTitle = t_('common.remove');
  const badge = _overlayBranchBadge(ov.branchId);
  const badgeHtml = `<span class="obj-branch" title="${_esc(badge.name)}">`
    + `<span class="obj-branch-dot" style="background:${badge.color}"></span>`
    + `<span class="obj-branch-name">${_esc(badge.name)}</span></span>`;

  row.innerHTML = `
    <span class="obj-icon">${icon}</span>
    <span class="obj-name">${name}</span>
    ${badgeHtml}
    <div class="obj-actions">
      <button class="icon-btn" data-act="eye" title="${eyeTitle}">
        ${ov.visible === false ? SVG_EYE_OFF : SVG_EYE_ON}
      </button>
      <button class="icon-btn danger" data-act="del" title="${removeTitle}">${SVG_TRASH}</button>
    </div>
  `;

  // Eye — toggle visibility. `ov` is the registry entry (main OR mini), so
  // ov.visible persists; also override the live overlay if one exists (a mini
  // overlay may be closed → registry-only toggle takes effect on next show).
  row.querySelector('[data-act="eye"]').addEventListener('click', () => {
    const newVis = ov.visible === false ? true : false;
    ov.visible = newVis;
    if (id) { try { _chartOf(id).overrideOverlay({ id, visible: newVis }); } catch (e) {} }
    schedulePersist();
    refreshObjectTree();
  });

  // Delete — chart-aware, with undo.
  row.querySelector('[data-act="del"]').addEventListener('click', () => {
    if (isMini) {
      const snap = {
        name: ov.name,
        points: (ov.points || []).map(p => ({ timestamp: p.timestamp, value: p.value })),
        styles: ov.styles, extendData: ov.extendData,
        lock: !!ov.lock, visible: ov.visible !== false,
        host: 'mini', branchId: ov.branchId || null,
      };
      if (id) { try { _chartOf(id).removeOverlay({ id }); } catch (e) {} }
      if (Drawing._miniRegistry && ov.key) Drawing._miniRegistry.delete(ov.key);
      if (id && Drawing.selectedOverlay && Drawing.selectedOverlay.id === id) Drawing.selectedOverlay = null;
      schedulePersist();
      refreshObjectTree();
      const ref = { ovid: null };
      pushUndo({
        label: 'Delete overlay',
        undo: () => { const nid = _recreateFromSnapshot(snap); if (nid) { ref.ovid = nid; refreshObjectTree(); } },
        redo: () => {
          if (ref.ovid) {
            const mini = window.MiniChart && window.MiniChart.chart;
            if (mini) { try { mini.removeOverlay({ id: ref.ovid }); } catch (e) {} }
            if (Drawing._miniRegistry) for (const [k, e] of Drawing._miniRegistry) { if (e._ovid === ref.ovid) { Drawing._miniRegistry.delete(k); break; } }
          }
          schedulePersist();
          refreshObjectTree();
        },
      });
      return;
    }
    // Main overlay
    const snap = _fullOverlaySnapshot(ov);
    if (id) { try { _chartOf(id).removeOverlay({ id }); } catch (e) {} }
    untrackOverlay(id);
    if (Drawing.selectedOverlay && Drawing.selectedOverlay.id === id) {
      Drawing.selectedOverlay = null;
    }
    refreshObjectTree();
    if (snap) {
      const ref = { id };
      pushUndo({
        label: 'Delete overlay',
        undo: () => { const newId = _recreateFromSnapshot(snap); if (newId) { ref.id = newId; refreshObjectTree(); } },
        redo: () => { try { _chartOf(ref.id).removeOverlay({ id: ref.id }); } catch (e) {} untrackOverlay(ref.id); refreshObjectTree(); },
      });
    }
  });

  // Row click → select on its chart. A mini overlay opens the mini for its
  // branch first (so it becomes live + visible), then selects (Aaron's spec:
  // left-click a sub-chart object auto-opens the sub-chart).
  row.addEventListener('click', (e) => {
    if (e.target.closest('.icon-btn')) return;
    if (isMini) selectMiniOverlayFromTree(ov);
    else selectOverlayFromTree(ov.id);
  });

  // Right click → 設定… / 跳轉至該物件位置. For a mini object both actions open
  // the mini first (settings needs the LIVE overlay, which only exists once the
  // mini is rendered); the jump also scrolls the K-bars.
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ts = (ov.points && ov.points[0] && Number.isFinite(ov.points[0].timestamp)) ? ov.points[0].timestamp : null;
    const lang = (window.I18n && window.I18n.lang) || 'zh';
    const t_ = (k, fb) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : fb;
    _showTreeCtxMenu(e.pageX, e.pageY, [
      {
        label: t_('ctx.settings', lang === 'en' ? 'Settings…' : '設定…'),
        onClick: () => {
          // Select exactly like a row click, then open the dialog on the live
          // overlay — showSettings routes position/fibo to their own panels.
          if (isMini) selectMiniOverlayFromTree(ov);
          else selectOverlayFromTree(ov.id);
          const sel = Drawing.selectedOverlay;
          if (sel && sel.name) showSettings(sel, getOverlayDisplayName(sel));
        },
      },
      {
        label: lang === 'en' ? 'Jump to object' : '跳轉至該物件位置',
        onClick: () => jumpToOverlay(host, ov.branchId, ts),
      },
    ]);
  });

  return row;
}

function makeIndicatorRow(ind) {
  const row = document.createElement('div');
  row.className = 'obj-row';
  const name = ind.shortName || ind.name || '(indicator)';
  const visible = ind.visible !== false;
  if (!visible) row.classList.add('disabled');
  const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
  const eyeTitle = visible ? t_('common.hide') : t_('common.show');

  row.innerHTML = `
    <span class="obj-icon">${SVG_IND_ICON}</span>
    <span class="obj-name">${name}</span>
    <div class="obj-actions">
      <button class="icon-btn" data-act="eye" title="${eyeTitle}">
        ${visible ? SVG_EYE_ON : SVG_EYE_OFF}
      </button>
    </div>
  `;

  row.querySelector('[data-act="eye"]').addEventListener('click', () => {
    try {
      Drawing.chart.overrideIndicator({
        name: ind.name, paneId: ind.paneId, id: ind.id, visible: !visible,
      });
    } catch (e) { console.error(e); }
    refreshObjectTree();
  });

  return row;
}

Drawing.refreshObjectTree = refreshObjectTree;

// =================================================================
// Reanchor overlay points with absolute dataIndex
// =================================================================
// KLineChart v9's timestamp→dataIndex uses binary search on the *currently
// loaded* data list. During replay, displayBars is truncated, so overlay
// points at timestamps beyond the cursor would be clamped to the last bar
// (rendering as a vertical line). Since v9.8.2, passing an explicit
// `dataIndex` on each point skips the search and lets the coordinate math
// extrapolate into the right-side empty space (setOffsetRightDistance).
//
// This helper finds the absolute dataIndex for each point's timestamp
// against the FULL baseBars (not the truncated displayBars) and extrapolates
// linearly for timestamps beyond the last bar.
/** Strip dataIndex when passing points back to KLineChart's overlay
 *  APIs (createOverlay / overrideOverlay).
 *
 *  KLineChart 9.8.10 treats `dataIndex` as authoritative whenever it
 *  appears alongside `timestamp`+`value` — it re-derives `value` from
 *  the bar's close at that index, silently discarding the user-drawn
 *  Y position. Empirically: a rect drawn at value=36619 / dataIndex=1296
 *  came back from overrideOverlay as value=35747 (= bar 1296's close),
 *  which collapses any undo/recreate flow into "snap to bar close".
 *
 *  Pass {timestamp, value} only; KLineChart computes its own dataIndex
 *  internally and stores it on the overlay after creation. Our registry
 *  copy gets the dataIndex back from the chart-side overlay if needed.
 *
 *  Used by: Move-overlay drag undo, Rect-resize drag undo, and
 *  _recreateFromSnapshot (delete undo). Initial draw and live drag don't
 *  need the strip — KLineChart owns those points the whole time. */
function _pointsForChart(points) {
  return (points || []).map(p => ({
    timestamp: p.timestamp,
    value: p.value,
  }));
}

/** Inverse of findDataIndexByTimestamp — recover a timestamp from a
 *  point's dataIndex even if the index is past the loaded bar range
 *  (klinecharts lets users draw overlays that extend past the last
 *  bar; those points carry only `dataIndex` and the position is
 *  conceptual — `(last_bar_ts) + (dataIndex - last_idx) * interval`).
 *
 *  Returns null when bars is empty or dataIndex isn't finite.
 *
 *  Used by `snapshot` / `_fullOverlaySnapshot` / reanchor — without
 *  this, a rectangle drawn with its right corner past the last bar
 *  would lose its timestamp during snapshot, and undo would recreate
 *  it with `dataIndex: 0` (collapsed to bar zero, totally wrong shape). */
function timestampFromPoint(p, bars) {
  if (!p) return null;
  if (Number.isFinite(p.timestamp)) return p.timestamp;
  if (!Number.isFinite(p.dataIndex) || !bars || !bars.length) return null;
  const idx = p.dataIndex;
  if (idx >= 0 && idx < bars.length && bars[idx]) {
    return bars[idx].timestamp;
  }
  if (bars.length >= 2) {
    if (idx >= bars.length) {
      const last = bars[bars.length - 1].timestamp;
      const interval = last - bars[bars.length - 2].timestamp;
      if (interval > 0) {
        return last + (idx - (bars.length - 1)) * interval;
      }
    } else if (idx < 0) {
      const first = bars[0].timestamp;
      const interval = bars[1].timestamp - first;
      if (interval > 0) {
        return first + idx * interval;
      }
    }
  }
  return null;
}

function findDataIndexByTimestamp(bars, ts) {
  if (!bars.length) return 0;
  // If beyond last bar, extrapolate using the bar interval
  const last = bars[bars.length - 1].timestamp;
  if (ts > last && bars.length >= 2) {
    const interval = last - bars[bars.length - 2].timestamp;
    if (interval > 0) {
      return (bars.length - 1) + Math.round((ts - last) / interval);
    }
  }
  // Binary search for nearest
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp === ts) return mid;
    if (bars[mid].timestamp < ts) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(0, Math.min(bars.length - 1, lo));
}

function reanchorOverlaysWithDataIndex(bars) {
  if (!Drawing.chart || !bars || !bars.length) return;
  for (const [id, entry] of Drawing.overlayRegistry) {
    if (!entry.points || !entry.points.length) continue;
    const newPoints = entry.points.map(p => {
      const out = { value: p.value };
      // timestampFromPoint handles the past-end / past-start dataIndex
      // cases that the previous `bars[p.dataIndex]` check missed —
      // overlays drawn extending past the last bar would otherwise stay
      // timestamp-less forever and break delete-undo.
      const ts = timestampFromPoint(p, bars);
      if (!Number.isFinite(ts)) return { ...p };
      out.timestamp = ts;
      out.dataIndex = findDataIndexByTimestamp(bars, ts);
      return out;
    });
    try {
      Drawing.chart.overrideOverlay({ id, points: newPoints });
    } catch (e) { /* ignore */ }
    entry.points = newPoints;
  }
}

Drawing.reanchorOverlaysWithDataIndex = reanchorOverlaysWithDataIndex;

Drawing.init = init;
Drawing.setTool = setTool;
Drawing.showSettings = showSettings;
Drawing.startRectTextEdit = startRectTextEdit;
Drawing.updateTrackedOverlay = updateTrackedOverlay;
// Generic color picker — exposed so the per-overlay position dialog can
// reuse the existing palette / custom / opacity popover instead of an
// `<input type="color">`. Caller passes the swatch anchor element, the
// starting hex / opacity, and an onChange callback.
Drawing.openGenericColorPicker = openGenericColorPicker;
Drawing.hideColorPopover = hideColorPopover;

// ===================================================================
// FiboSettings — per-overlay settings popover for fibo_retrace /
// fibo_extension. Mirrors window.PositionOverlaySettings' shape:
// init() wires DOM once, open(overlay) snapshots state + populates,
// applyLive() pushes live changes onto the overlay, cancel() reverts
// to snapshot, confirm() commits + closes.
// ===================================================================
const FiboSettings = {
  el: null,
  currentOverlay: null,
  snapshot: null,
  _t(k, vars) {
    return (window.I18n && window.I18n.t) ? window.I18n.t(k, vars) : k;
  },
  isOpen() { return this.el && !this.el.classList.contains('hidden'); },

  init() {
    this.el = document.getElementById('fibo-overlay-settings');
    if (!this.el) return;
    document.getElementById('fibo-ov-close').addEventListener('click', () => this.cancel());
    document.getElementById('fibo-cancel').addEventListener('click',  () => this.cancel());
    document.getElementById('fibo-confirm').addEventListener('click', () => this.confirm());

    // Drag dialog by its header (mirrors PositionOverlaySettings._installDrag).
    this._installDrag();

    // Outside-click closes the popover — click on the main chart, the
    // toolbar, or anywhere outside the dialog reverts via cancel(). This
    // matches the user's request "點擊主圖關閉". Color picker / template
    // popover are nested inside #fibo-overlay-settings so this.el.contains
    // covers them; but we still need to exclude the standalone #sp-color-pop
    // which is a body-level sibling.
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (!this.isOpen()) return;
      if (this.el.contains(e.target)) return;
      // Allow swatch / palette interactions to NOT close the dialog —
      // those raise the color popover outside this.el.
      if (e.target.closest('.color-swatch')) return;
      const colorPop = document.getElementById('sp-color-pop');
      if (colorPop && colorPop.contains(e.target)) return;
      this.cancel();
    }, true);

    // Tab switching.
    this.el.querySelectorAll('.tab[data-fibo-tab]').forEach(btn => {
      btn.addEventListener('click', () => this._switchTab(btn.dataset.fiboTab));
    });

    // Color swatches (trend-line + single-color) — reuse Drawing's
    // generic palette popover. Per-level swatches in the grid get
    // their own listener attached when rendered in _renderLevelGrid.
    [['fibo-trendline-color', '#787b86'],
     ['fibo-single-color',    '#2962ff']].forEach(([id, def]) => {
      const sw = document.getElementById(id);
      if (!sw) return;
      sw.dataset.color = def;
      sw.style.background = def;
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = sw.dataset.color || def;
        if (window.Drawing && window.Drawing.openGenericColorPicker) {
          window.Drawing.openGenericColorPicker(sw, cur, 1, (hex) => {
            sw.dataset.color = hex;
            sw.style.background = hex;
            this._applyLive();
          });
        }
      });
    });

    // Outside-click-closes-color-popover (same dance PositionOverlaySettings
    // does — its global listener only fires while ITS panel is open).
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (!this.isOpen()) return;
      const colorPop = document.getElementById('sp-color-pop');
      if (!colorPop || colorPop.classList.contains('hidden')) return;
      if (colorPop.contains(e.target)) return;
      if (e.target.closest('.color-swatch')) return;
      if (window.Drawing && window.Drawing.hideColorPopover) {
        window.Drawing.hideColorPopover();
      }
    }, true);

    // Live-update wiring for the static (non-level-grid) controls.
    const liveIds = [
      'fibo-trendline-on', 'fibo-trendline-style',
      'fibo-hline-style', 'fibo-extend',
      'fibo-single-color-on',
      'fibo-bg-on', 'fibo-bg-alpha',
      'fibo-reverse',
      'fibo-visible-cb', 'fibo-locked-cb',
    ];
    for (const id of liveIds) {
      const el = document.getElementById(id);
      if (!el) continue;
      const ev = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
      el.addEventListener(ev, () => this._applyLive());
    }

    // Template menu.
    const tplBtn = document.getElementById('fibo-tpl-btn');
    const tplPop = document.getElementById('fibo-tpl-popover');
    if (tplBtn && tplPop) {
      tplBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        tplPop.hidden = !tplPop.hidden;
        if (!tplPop.hidden) this._renderTemplateList();
      });
      tplPop.addEventListener('click', (e) => {
        const item = e.target.closest('.fibo-tpl-item');
        if (!item) return;
        const tpl = item.dataset.fiboTpl;
        if (tpl === 'default') this._applyTemplate('default');
        else if (tpl === 'save-as') this._saveCurrentAsTemplate();
        else if (item.dataset.fiboTplName) this._applyTemplate(item.dataset.fiboTplName);
        tplPop.hidden = true;
      });
      document.addEventListener('mousedown', (e) => {
        if (tplPop.hidden) return;
        if (e.target.closest('#fibo-tpl-btn') || tplPop.contains(e.target)) return;
        tplPop.hidden = true;
      });
    }

    // Esc closes (reverts).
    document.addEventListener('keydown', (e) => {
      if (this.isOpen() && e.key === 'Escape') { this.cancel(); e.preventDefault(); }
    });
  },

  _switchTab(tab) {
    this.el.querySelectorAll('.tab[data-fibo-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.fiboTab === tab);
    });
    this.el.querySelectorAll('.fibo-tab-body').forEach(sec => {
      sec.classList.toggle('hidden', sec.dataset.fiboTab !== tab);
    });
  },

  // Re-center the dialog horizontally + pin to a stable top each time it
  // opens. Wipes any inline left/top from a previous drag so the user
  // always starts from the same place. (Mirrors PositionOverlaySettings.)
  _recenter() {
    if (!this.el) return;
    this.el.style.left = '';
    this.el.style.top = '';
    this.el.style.transform = '';
  },

  _installDrag() {
    const header = this.el && this.el.querySelector('header');
    if (!header) return;
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // Don't start drag when clicking the X close button.
      if (e.target.closest('button')) return;
      const rect = this.el.getBoundingClientRect();
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      // Lock current position via inline styles, kill the centering transform.
      this.el.style.left = startLeft + 'px';
      this.el.style.top  = startTop + 'px';
      this.el.style.transform = 'none';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      this.el.style.left = (startLeft + (e.clientX - startX)) + 'px';
      this.el.style.top  = (startTop  + (e.clientY - startY)) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) document.body.style.userSelect = '';
      dragging = false;
    });
  },

  open(overlay) {
    if (!overlay || !this.el) return;
    this.currentOverlay = overlay;
    // Deep snapshot for cancel revert.
    this.snapshot = {
      extendData: overlay.extendData ? JSON.parse(JSON.stringify(overlay.extendData)) : null,
      visible:    overlay.visible !== false,
      lock:       !!overlay.lock,
      points:     (overlay.points || []).map(p => ({ ...p })),
    };

    // Ensure extendData has the fibo config seeded.
    if (!overlay.extendData || !overlay.extendData.fibo || !overlay.extendData.levels) {
      try {
        Drawing.chart.overrideOverlay({ id: overlay.id, extendData: _newFiboExtendData() });
      } catch (e) {}
      overlay.extendData = _newFiboExtendData();
    }

    // Title.
    const titleKey = overlay.name === 'fibo_time'      ? 'panel.fibo.titleTime'
                   : overlay.name === 'fibo_extension' ? 'panel.fibo.titleExtension'
                   :                                     'panel.fibo.titleRetrace';
    document.getElementById('fibo-ov-title').textContent = this._t(titleKey);

    // Trend-line row applies to both retrace (p1→p2 dashed connector) and
    // extension (p1→p2→p3 connector pair). Always show.
    const trendRow = this.el.querySelector('.fibo-row-trend');
    if (trendRow) trendRow.classList.remove('hidden');

    // Populate static controls.
    const fibo = overlay.extendData.fibo;
    document.getElementById('fibo-trendline-on').checked = !!fibo.trendLineColor;
    const tlColor = document.getElementById('fibo-trendline-color');
    tlColor.dataset.color = fibo.trendLineColor || '#787b86';
    tlColor.style.background = tlColor.dataset.color;
    document.getElementById('fibo-trendline-style').value = fibo.trendLineStyle || 'dashed';
    document.getElementById('fibo-hline-style').value     = fibo.hLineStyle     || 'solid';
    document.getElementById('fibo-extend').value          = fibo.extend         || 'none';
    document.getElementById('fibo-single-color-on').checked = !!fibo.singleColor;
    const scSw = document.getElementById('fibo-single-color');
    scSw.dataset.color = fibo.singleColor || '#2962ff';
    scSw.style.background = scSw.dataset.color;
    document.getElementById('fibo-bg-on').checked         = !!fibo.showBackground;
    document.getElementById('fibo-bg-alpha').value        = fibo.backgroundAlpha != null
                                                          ? fibo.backgroundAlpha : 0.18;
    document.getElementById('fibo-reverse').checked       = !!fibo.reverse;
    document.getElementById('fibo-visible-cb').checked    = overlay.visible !== false;
    document.getElementById('fibo-locked-cb').checked     = !!overlay.lock;

    this._renderLevelGrid(overlay.extendData.levels);
    this._renderCoordsRows(overlay);

    this._switchTab('style');
    this._recenter();
    this.el.classList.remove('hidden');
    this.el.setAttribute('aria-hidden', 'false');
  },

  _renderLevelGrid(levels) {
    const grid = document.getElementById('fibo-levels-grid');
    if (!grid) return;
    grid.innerHTML = '';
    levels.forEach((L, idx) => {
      const cell = document.createElement('div');
      cell.className = 'fibo-level-cell';
      cell.innerHTML = `
        <input type="checkbox" class="fibo-level-on" ${L.on ? 'checked' : ''} data-idx="${idx}">
        <input type="number" class="fibo-level-r" step="any" value="${L.r}" data-idx="${idx}">
        <button class="color-swatch fibo-swatch fibo-level-color" data-idx="${idx}"
                style="background:${L.color}" data-color="${L.color}"></button>
      `;
      grid.appendChild(cell);
    });
    // Wire listeners (delegated would be cleaner but this is simpler for now).
    grid.querySelectorAll('.fibo-level-on').forEach(cb => {
      cb.addEventListener('change', () => this._applyLive());
    });
    grid.querySelectorAll('.fibo-level-r').forEach(inp => {
      inp.addEventListener('input', () => this._applyLive());
    });
    grid.querySelectorAll('.fibo-level-color').forEach(sw => {
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = sw.dataset.color || '#888';
        if (window.Drawing && window.Drawing.openGenericColorPicker) {
          window.Drawing.openGenericColorPicker(sw, cur, 1, (hex) => {
            sw.dataset.color = hex;
            sw.style.background = hex;
            this._applyLive();
          });
        }
      });
    });
  },

  _renderCoordsRows(overlay) {
    const wrap = document.getElementById('fibo-coords-rows');
    if (!wrap) return;
    wrap.innerHTML = '';
    const points = overlay.points || [];
    points.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'row fibo-coord-row';
      row.innerHTML = `
        <label>#${i + 1} <span class="fibo-coord-hint" data-i18n="panel.fibo.coordHint">（價格，K棒）</span></label>
        <input type="number" class="fibo-coord-price" step="any" value="${p.value != null ? p.value : ''}" data-idx="${i}">
        <input type="number" class="fibo-coord-bar"   step="1"   value="${p.dataIndex != null ? p.dataIndex : ''}" data-idx="${i}">
      `;
      wrap.appendChild(row);
    });
    wrap.querySelectorAll('.fibo-coord-price, .fibo-coord-bar').forEach(inp => {
      inp.addEventListener('input', () => this._applyLive());
    });
  },

  _collectFiboConfigFromUI() {
    const fibo = {};
    fibo.trendLineColor = document.getElementById('fibo-trendline-on').checked
      ? (document.getElementById('fibo-trendline-color').dataset.color || '#787b86') : null;
    fibo.trendLineStyle = document.getElementById('fibo-trendline-style').value;
    fibo.hLineStyle     = document.getElementById('fibo-hline-style').value;
    fibo.extend         = document.getElementById('fibo-extend').value;
    fibo.singleColor    = document.getElementById('fibo-single-color-on').checked
      ? (document.getElementById('fibo-single-color').dataset.color || '#2962ff') : null;
    fibo.showBackground = document.getElementById('fibo-bg-on').checked;
    fibo.backgroundAlpha = parseFloat(document.getElementById('fibo-bg-alpha').value) || 0.18;
    fibo.reverse        = document.getElementById('fibo-reverse').checked;
    return fibo;
  },
  _collectLevelsFromUI() {
    const grid = document.getElementById('fibo-levels-grid');
    if (!grid) return [];
    const cells = Array.from(grid.querySelectorAll('.fibo-level-cell'));
    return cells.map(cell => {
      const onEl = cell.querySelector('.fibo-level-on');
      const rEl  = cell.querySelector('.fibo-level-r');
      const cEl  = cell.querySelector('.fibo-level-color');
      return {
        r:     parseFloat(rEl.value) || 0,
        on:    !!onEl.checked,
        color: cEl.dataset.color || '#888888',
      };
    });
  },
  _collectPointsFromUI() {
    const wrap = document.getElementById('fibo-coords-rows');
    if (!wrap) return null;
    const rows = Array.from(wrap.querySelectorAll('.fibo-coord-row'));
    if (!rows.length) return null;
    const original = (this.currentOverlay && this.currentOverlay.points) || [];
    return rows.map((row, i) => {
      const priceEl = row.querySelector('.fibo-coord-price');
      const barEl   = row.querySelector('.fibo-coord-bar');
      const base = original[i] || {};
      const value = parseFloat(priceEl.value);
      const idx   = parseInt(barEl.value, 10);
      // Convert dataIndex → timestamp via the ACTIVE bar table. In replay the
      // point's dataIndex is baseBars-relative (the chart shows displayBars, but
      // overlay indices map to baseBars); using App.currentBars (the recent
      // window) here would look up the WRONG bar and corrupt the timestamp —
      // which collapses the X-projected fibo_time on any settings edit while a
      // price fibo (Y-dominant) survives.
      const R = window.Replay;
      const bars = (R && R.active && Array.isArray(R.baseBars) && R.baseBars.length)
        ? R.baseBars
        : ((window.App && window.App.currentBars) || []);
      let timestamp = base.timestamp;
      if (Number.isFinite(idx) && bars[idx]) timestamp = bars[idx].timestamp;
      return {
        ...base,
        value: Number.isFinite(value) ? value : base.value,
        dataIndex: Number.isFinite(idx) ? idx : base.dataIndex,
        timestamp,
      };
    });
  },

  _applyLive() {
    if (!this.currentOverlay || !Drawing.chart) return;
    const ov = this.currentOverlay;
    const fibo = this._collectFiboConfigFromUI();
    const levels = this._collectLevelsFromUI();
    const newExtend = { ...(ov.extendData || {}), fibo, levels };
    const newPoints = this._collectPointsFromUI();
    const patch = { id: ov.id, extendData: newExtend };
    if (newPoints) patch.points = newPoints;
    try { Drawing.chart.overrideOverlay(patch); } catch (e) {}
    // Remember this as the last-used config for THIS fibo family (fibo_time has
    // its own store) so the next same-kind fibo inherits it.
    if (Drawing._saveLastUsedFibo) Drawing._saveLastUsedFibo(fibo, levels, ov.name);
    // Live mutation of the in-memory overlay so subsequent reads see the
    // updated state without waiting for a confirm.
    ov.extendData = newExtend;
    if (newPoints) ov.points = newPoints;
    // Visibility + lock are stored separately on the overlay (not in
    // extendData), so apply via override too.
    const visible = document.getElementById('fibo-visible-cb').checked;
    const locked  = document.getElementById('fibo-locked-cb').checked;
    if (ov.visible !== visible || ov.lock !== locked) {
      try { Drawing.chart.overrideOverlay({ id: ov.id, visible, lock: locked }); } catch (e) {}
      ov.visible = visible;
      ov.lock = locked;
    }
  },

  cancel() {
    if (!this.currentOverlay || !this.snapshot) { this._close(); return; }
    const ov = this.currentOverlay;
    try {
      Drawing.chart.overrideOverlay({
        id: ov.id,
        extendData: this.snapshot.extendData,
        points:     this.snapshot.points,
        visible:    this.snapshot.visible,
        lock:       this.snapshot.lock,
      });
    } catch (e) {}
    ov.extendData = this.snapshot.extendData;
    ov.points     = this.snapshot.points;
    ov.visible    = this.snapshot.visible;
    ov.lock       = this.snapshot.lock;
    this._close();
  },
  confirm() {
    // applyLive has been pushing state on every change, so confirm is
    // just close — except we also persist via trackOverlay so the
    // registry reflects the new state and the next /api/drawings PUT
    // serializes it.
    if (this.currentOverlay && Drawing.overlayRegistry) {
      const entry = Drawing.overlayRegistry.get(this.currentOverlay.id);
      if (entry) {
        entry.extendData = this.currentOverlay.extendData;
        entry.points     = this.currentOverlay.points;
        entry.visible    = this.currentOverlay.visible;
        entry.lock       = this.currentOverlay.lock;
      }
    }
    if (typeof scheduleDrawingsPersist === 'function') {
      try { scheduleDrawingsPersist(); } catch (e) {}
    }
    this._close();
  },
  _close() {
    this.el.classList.add('hidden');
    this.el.setAttribute('aria-hidden', 'true');
    this.currentOverlay = null;
    this.snapshot = null;
  },

  // ----- Template management -----
  // Fibo templates persist SERVER-SIDE (user_data/templates.json) under the
  // `fibo` bucket, via the same shared store the trendline/rectangle templates
  // use (_loadAll / _saveAll → localStorage cache + PUT /api/templates + boot
  // sync). Previously they lived in a localStorage-only key, so they were lost
  // whenever localStorage was cleared / a different context was used and never
  // reached the server — hence "saved but not retained after restart". The
  // built-in default (FIBO_*_DEFAULTS) is never stored.
  _TPL_LEGACY_KEY: 'chart_viewer.fibo_templates',   // migration source only
  _TPL_BUCKET: 'fibo',
  _loadTemplates() {
    try {
      const all = _loadAll();
      const arr = all[this._TPL_BUCKET];
      if (Array.isArray(arr)) return arr;
      // One-time migration from the old localStorage-only store.
      const raw = localStorage.getItem(this._TPL_LEGACY_KEY);
      const legacy = raw ? JSON.parse(raw) : [];
      if (Array.isArray(legacy) && legacy.length) {
        this._saveTemplates(legacy);   // push into the shared store + server
        return legacy;
      }
      return [];
    } catch (e) { return []; }
  },
  _saveTemplates(arr) {
    try {
      const all = _loadAll();
      all[this._TPL_BUCKET] = arr;
      _saveAll(all);                   // writes localStorage cache AND PUTs to /api/templates
    } catch (e) {}
  },
  _renderTemplateList() {
    const pop = document.getElementById('fibo-tpl-popover');
    const sep = document.getElementById('fibo-tpl-sep');
    if (!pop) return;
    // Remove previously-injected saved-template items.
    pop.querySelectorAll('.fibo-tpl-saved').forEach(n => n.remove());
    const saved = this._loadTemplates();
    if (saved.length) {
      sep.hidden = false;
      for (const t of saved) {
        const item = document.createElement('div');
        item.className = 'fibo-tpl-item fibo-tpl-saved';
        item.dataset.fiboTplName = t.name;
        item.textContent = t.name;
        pop.appendChild(item);
      }
    } else {
      sep.hidden = true;
    }
  },
  _applyTemplate(name) {
    if (!this.currentOverlay) return;
    let fibo, levels;
    if (name === 'default') {
      fibo   = JSON.parse(JSON.stringify(FIBO_CONFIG_DEFAULTS));
      levels = JSON.parse(JSON.stringify(FIBO_LEVEL_DEFAULTS));
    } else {
      const saved = this._loadTemplates().find(t => t.name === name);
      if (!saved) return;
      fibo   = JSON.parse(JSON.stringify(saved.fibo));
      levels = JSON.parse(JSON.stringify(saved.levels));
    }
    this.currentOverlay.extendData = {
      ...(this.currentOverlay.extendData || {}),
      fibo, levels,
    };
    // Applying a template makes it the last-used config → next same-kind fibo
    // inherits it (per-family store).
    if (Drawing._saveLastUsedFibo) Drawing._saveLastUsedFibo(fibo, levels, this.currentOverlay && this.currentOverlay.name);
    // Re-populate UI from the new template, then live-push to overlay.
    this.open(this.currentOverlay);
  },
  _saveCurrentAsTemplate() {
    const name = prompt(this._t('panel.fibo.tplNamePrompt') || '範本名稱：');
    if (!name || !name.trim()) return;
    const fibo   = this._collectFiboConfigFromUI();
    const levels = this._collectLevelsFromUI();
    const saved = this._loadTemplates();
    const trimmed = name.trim();
    // Replace existing with same name.
    const filtered = saved.filter(t => t.name !== trimmed);
    filtered.push({ name: trimmed, fibo, levels });
    this._saveTemplates(filtered);
  },
};

window.FiboSettings = FiboSettings;
Drawing.FiboSettings = FiboSettings;
