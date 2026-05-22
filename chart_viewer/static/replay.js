/**
 * replay.js — TradingView-style replay engine.
 *
 * Behavior:
 *   - Display TF = window.App.currentTF (e.g. "15m")
 *   - Sub TF (driver) = user-chosen, default 1m
 *   - The latest display bar grows tick-by-tick as sub-bars stream in.
 *     When a sub-bar crosses the display-bar boundary, the in-progress
 *     bar is finalized and a new one is started.
 *
 * UI controls:
 *   選擇K線 - click chart to set replay start (truncates history at click point)
 *   ▶/⏸ - play/pause (Space)
 *   ▶| - step one sub-bar
 *   speed - tick rate multiplier (3x = ~333ms/sub-bar)
 *   subtf - granularity of replay driver (1m default)
 *   ▶▶| - jump to end (apply remaining sub-bars instantly)
 */
/* global */

const Replay = {
  chart: null,
  active: false,
  playing: false,
  picking: false,

  baseBars: [],          // all display bars from API (full range)
  displayBars: [],       // past bars + in-progress bar + LOOKAHEAD future placeholders
  subBars: [],           // sub-TF bars from cursor onwards (driver)
  cursorIdx: 0,          // pointer into subBars
  cursorTimestamp: null, // ms — TF-invariant cursor position
  // Highest cursorTimestamp ever reached during this replay session — only
  // grows. Used by branching-replay-spec §3.2.3: if cursorTimestamp <
  // maxCursorTs the user has navigated to a past bar (saw the future),
  // and the next order-on-main triggers the cursor-jump fork prompt.
  // Reset on Replay.start / _doExitReplay / enterReplayRestore alongside
  // cursorTimestamp.
  maxCursorTs: null,
  cursorBarIdx: 0,       // index in displayBars of the current in-progress bar
  inProgressBar: null,   // reference to displayBars[cursorBarIdx]
  tickHistory: [],       // stack of undo snapshots for step-back

  subTf: '1m',
  displayTfMs: 15 * 60000,
  subTfMs: 60000,

  intervalHandle: null,
  speed: 3,
};
const TICK_HISTORY_CAP = 1000;
Replay.FOG_PX = 500;    // legacy — kept for safety, no longer used for replay fog
const LOOKAHEAD_BARS = 100;   // always reserve 100 future time slots past cursor
window.Replay = Replay;

// The fixed price all placeholder bars sit at during replay. Set at cursor-
// pick time to the last real bar's close, and reused by tick() when pushing
// new placeholders. Constant across the whole replay session so placeholders
// form ONE flat invisible line instead of drifting doji dots.
Replay.placeholderFillPrice = 0;

// Tick-time chart redraw that bypasses KLineChart's `applyNewData(Init)`
// which calls `_chartStore.clear()` — wiping `_tooltipStore` (= the
// crosshair the user's mouse is hovering) and `_timeScaleStore` (= the
// visible-range offset, which causes view to snap right). The combination
// produces visible flicker every tick (~333ms): crosshair disappears
// briefly, view jumps to the right edge then JS restores it, fighting
// any in-progress user drag.
//
// Since we mutate `Replay.displayBars` in place (or push to it) BEFORE
// triggering redraw, and KLineChart's internal `_chartStore._dataList`
// is the same array reference, the data is already up-to-date. What we
// still need to mirror from addData's tail (without the destructive
// clear() at the head):
//   - `_overlayStore.updatePointPosition` — keeps overlay (e.g. trade
//     arrows) anchored to the right bars when bars get pushed.
//   - `_timeScaleStore.adjustVisibleRange` — refreshes the visible-bars
//     window so newly-pushed bars enter the rendered set.
//   - `_tooltipStore.recalculateCrosshair(true)` — re-projects crosshair
//     pixel position from its kept (timestamp,value) state. NOT clear.
//   - `_indicatorStore.calcInstance` — async recompute of indicators.
//   - `_chart.adjustPaneViewport` — final layout + redraw.
//
// Path (KLineChart 9.8.10 minified): `chart._chartStore._chart` is the
// inner ChartImp. Pinned to this version, feature-detected anyway.
//
// Returns true on the fast path, false if any of the private hooks are
// missing (caller falls back to applyNewData).
let _adjustPaneViewportProbed = false;
function _redrawTickInPlace(barsAdded) {
  const chart = Replay.chart;
  const cs = chart && chart._chartStore;
  if (!cs) return false;
  const inner = cs._chart;
  const ok = inner && typeof inner.adjustPaneViewport === 'function';
  if (!_adjustPaneViewportProbed) {
    _adjustPaneViewportProbed = true;
    try {
      console.log('[replay-redraw] private path ' + (ok ? 'OK' : 'NOT FOUND, falling back to applyNewData'));
    } catch (e) { /* ignore */ }
  }
  if (!ok) return false;
  try {
    // Match addData(...)'s tail. `a` (added count) is 1 when we pushed
    // a placeholder this tick, 0 for in-place same-bar mutation. The
    // overlayStore uses it to shift overlays when bars are appended at
    // the right edge.
    const a = barsAdded ? 1 : 0;
    if (cs._overlayStore && typeof cs._overlayStore.updatePointPosition === 'function') {
      try { cs._overlayStore.updatePointPosition(a, undefined); } catch (e) {}
    }
    if (cs._timeScaleStore && typeof cs._timeScaleStore.adjustVisibleRange === 'function') {
      try { cs._timeScaleStore.adjustVisibleRange(); } catch (e) {}
    }
    if (cs._tooltipStore && typeof cs._tooltipStore.recalculateCrosshair === 'function') {
      try { cs._tooltipStore.recalculateCrosshair(true); } catch (e) {}
    }
    if (cs._indicatorStore && typeof cs._indicatorStore.calcInstance === 'function') {
      // Fire and forget — async, return value (Promise) ignored.
      try { cs._indicatorStore.calcInstance(); } catch (e) {}
    }
    inner.adjustPaneViewport(false, true, true, true);
    return true;
  } catch (e) { return false; }
}

// Bump Replay.maxCursorTs to the current cursor if the cursor moved forward.
// Called after every cursor mutation (forward tick, pick, stepBack restore,
// setCursorAtTimestamp). Backward jumps no-op because of the > check.
// Spec: branching-replay-spec §3.2.3 — see `Replay.maxCursorTs` field doc.
function _bumpMaxCursorTs() {
  const ts = Replay.cursorTimestamp;
  if (!Number.isFinite(ts)) return;
  if (Replay.maxCursorTs == null || ts > Replay.maxCursorTs) {
    Replay.maxCursorTs = ts;
  }
}

// Build `count` placeholder bars starting at display-bar index `fromIdx`.
// Each placeholder: valid timestamp + OHLC all equal to Replay.placeholderFillPrice
// (invisible candle, valid Y-axis math). Tagged with `_placeholder: true`.
function makeFutureSlots(fromIdx, count) {
  const slots = [];
  const base = Replay.baseBars;
  const tfMs = Replay.displayTfMs || 60000;
  const fillPrice = Replay.placeholderFillPrice || 0;
  // Stretched range so KLineChart's Y-axis autoscale stays stable when
  // the user pans into the placeholder zone (see `_computePlaceholderRange`).
  // Body is still flat (open === close === fillPrice) so visually the
  // placeholder reads as a thin horizontal line; wicks reach to phHigh /
  // phLow but are styled invisible during replay via _hidePlaceholderWicks.
  const phHigh = Number.isFinite(Replay.placeholderHigh) ? Replay.placeholderHigh : fillPrice;
  const phLow  = Number.isFinite(Replay.placeholderLow)  ? Replay.placeholderLow  : fillPrice;
  let lastTs = null;
  for (let i = 0; i < count; i++) {
    const absIdx = fromIdx + i;
    let ts;
    if (base[absIdx]) {
      ts = base[absIdx].timestamp;
    } else {
      if (lastTs == null) {
        lastTs = (base[base.length - 1] ? base[base.length - 1].timestamp : Date.now())
                 + (absIdx - base.length + 1) * tfMs;
        ts = lastTs;
      } else {
        lastTs += tfMs;
        ts = lastTs;
      }
    }
    slots.push({
      timestamp: ts,
      open: fillPrice, close: fillPrice,
      high: phHigh,    low: phLow,
      volume: 0,
      _placeholder: true,
    });
  }
  return slots;
}

// Is this a placeholder we made ourselves (vs. a real bar or partial)?
function isPlaceholderBar(bar) {
  return !bar || bar._placeholder === true;
}

// ---- Helpers ----
// TF convention: no suffix / "min" = minutes; m = month; h = hour; d = day; w = week.
function parseTfMs(tf) {
  const m = tf.match(/^(\d+)(min|[mhdw])?$/i);
  if (!m) return 60000;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 'min').toLowerCase();
  const unitMs = {
    min: 60000,
    m:   30 * 86400000,   // 1 month ≈ 30 days (approximation for UI math)
    h:   3600000,
    d:   86400000,
    w:   7 * 86400000,
  };
  return n * (unitMs[unit] || 60000);
}

function tickIntervalMs() {
  return Math.max(20, Math.floor(1000 / Replay.speed));
}

function tsToISO(ms) {
  return new Date(ms).toISOString();
}

async function fetchSubBars(tf, startMs, endMs) {
  const params = new URLSearchParams({
    tf,
    start: tsToISO(startMs),
    end: tsToISO(endMs),
  });
  // Follow App.currentSymbol so replay stays on the right instrument —
  // otherwise the backend falls back to the first-loaded symbol (NQ1) and
  // timestamps don't line up, making tick() / stepBack() silently no-op.
  const symbol = window.App && window.App.currentSymbol;
  if (symbol) params.set('symbol', symbol);
  const r = await fetch(`/api/ohlcv?${params}`);
  if (!r.ok) throw new Error('sub-bar fetch failed');
  return r.json();
}

// ---- Persistent save/restore (per layout × symbol) ---------------------
// Saved state at user_data/layouts/<layoutId>/replay/<symbol>.json:
//   { cursorTimestamp, tf, subTf, savedAt }
// localStorage is cache only — backend is source of truth.
function _replayKey(symbol, layoutId) {
  const sym = symbol || 'default';
  const lid = layoutId || (window.App && window.App.currentLayoutId) || 'default';
  return `chart_viewer_replay_v2_${lid}_${sym}`;
}
function _layoutId(lid) { return lid || (window.App && window.App.currentLayoutId); }

function saveReplayState(symbol, state, layoutId) {
  if (!symbol) return;
  const lid = _layoutId(layoutId);
  try { localStorage.setItem(_replayKey(symbol, lid), JSON.stringify(state)); } catch (e) {}
  if (!lid) return;
  // Fire-and-forget — backend is best-effort.
  fetch(`/api/replay?layout=${encodeURIComponent(lid)}&symbol=${encodeURIComponent(symbol)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  }).catch(() => {});
}

// Force-refresh the mini chart immediately after a replay-cursor
// mutation. Without this, the mini relied on its rAF dirty-check to
// notice that displayBars had changed; that's enough at idle but
// breaks during active ticking (held . key / play 5x):
//
//   1. main.applyNewData adds a bar         → main length = N+1
//   2. main.scrollToDataIndex(cursor + 5)   → fires onScroll
//   3. Our onScroll mirror runs scrollByDistance on the mini, but
//      the mini still has dataLength = N because its _applyData
//      hasn't fired yet (rAF detection lag) — the mini scrolls
//      past its own dataset.
//   4. Next rAF, _maybeRefreshData notices and calls _applyData,
//      which reapplies + _syncFromMain... but step 3 already
//      pushed the mini into a junk position. User sees the K-bars
//      jitter / shift on every tick.
//
// Calling refreshData() explicitly at the same hook points as
// _markReplayDirty (the 4 cursor mutators) puts mini's applyNewData
// + _syncFromMain INSIDE the same call stack as the main mutation,
// before any rAF runs. The rAF dirty-check stays as a safety net for
// non-replay paths.
function _refreshMini() {
  const M = window.MiniChart;
  if (M && M.refreshData) {
    try { M.refreshData(); } catch (e) { /* ignore */ }
  }
}

// Debounced auto-save of the live replay cursor. Called after every
// mutation that changes Replay.cursorTimestamp (pick, tick, stepBack,
// setCursorAtTimestamp). Without this, the saved snapshot only updated
// on exit-replay → user F5'd mid-session and the resume dialog
// brought them back to a stale cursor.
//
// 250ms debounce coalesces fast-tick streams (period key held / play
// mode at 5x) into a single PUT. exitReplay still calls saveReplayState
// directly to guarantee one final write before teardown.
let _replaySaveTimer = null;
function _markReplayDirty() {
  if (!Replay.active) return;
  if (!window.App || !window.App.currentSymbol) return;
  if (_replaySaveTimer != null) clearTimeout(_replaySaveTimer);
  _replaySaveTimer = setTimeout(() => {
    _replaySaveTimer = null;
    if (!Replay.active) return;
    if (!Replay.cursorTimestamp) return;
    saveReplayState(window.App.currentSymbol, {
      cursorTimestamp: Replay.cursorTimestamp,
      tf: window.App.currentTF,
      subTf: Replay.subTf,
      savedAt: Date.now(),
    });
  }, 250);
}

// Synchronous read from cache — used on symbol-switch auto-restore path.
function loadReplayState(symbol, layoutId) {
  if (!symbol) return null;
  const lid = _layoutId(layoutId);
  try {
    const raw = localStorage.getItem(_replayKey(symbol, lid));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// Async read from backend — used by enterReplay() to get authoritative state.
async function loadReplayStateAsync(symbol, layoutId) {
  if (!symbol) return null;
  const lid = _layoutId(layoutId);
  if (!lid) return loadReplayState(symbol);
  try {
    const r = await fetch(`/api/replay?layout=${encodeURIComponent(lid)}&symbol=${encodeURIComponent(symbol)}`);
    if (r.ok) {
      const j = await r.json();
      if (j && typeof j === 'object' && j.cursorTimestamp) {
        // Refresh cache.
        try { localStorage.setItem(_replayKey(symbol, lid), JSON.stringify(j)); } catch (e) {}
        return j;
      }
    }
  } catch (e) { /* fall back to cache */ }
  return loadReplayState(symbol, lid);
}

function clearReplayState(symbol, layoutId) {
  if (!symbol) return;
  const lid = _layoutId(layoutId);
  try { localStorage.removeItem(_replayKey(symbol, lid)); } catch (e) {}
  if (!lid) return;
  fetch(`/api/replay?layout=${encodeURIComponent(lid)}&symbol=${encodeURIComponent(symbol)}`, {
    method: 'DELETE',
  }).catch(() => {});
}

// ---- Generic modal helper --------------------------------------------
// Returns a Promise that resolves with one of: 'primary', 'secondary', 'close'.
function showReplayDialog({ title, body, showCheckbox = false, checkboxLabel,
                            primaryLabel, secondaryLabel }) {
  // Default checkbox label resolves at call time so language flips
  // before reopen show the new locale's "Save this session".
  if (checkboxLabel == null) {
    checkboxLabel = (window.I18n && window.I18n.t)
      ? window.I18n.t('replay.dlgSaveSession') : '儲存此重播';
  }
  return new Promise((resolve) => {
    const dlg = document.getElementById('replay-dialog');
    document.getElementById('rd-title').textContent = title;
    document.getElementById('rd-body').textContent = body;
    document.getElementById('rd-options').classList.toggle('hidden', !showCheckbox);
    if (showCheckbox) {
      document.querySelector('#rd-options label').lastChild.nodeValue = ' ' + checkboxLabel;
    }
    const primary = document.getElementById('rd-btn-primary');
    const secondary = document.getElementById('rd-btn-secondary');
    const closeBtn = document.getElementById('rd-close');
    primary.textContent = primaryLabel;
    secondary.textContent = secondaryLabel;

    const cleanup = () => {
      dlg.classList.add('hidden');
      primary.removeEventListener('click', onP);
      secondary.removeEventListener('click', onS);
      closeBtn.removeEventListener('click', onC);
      dlg.querySelector('.rd-backdrop').removeEventListener('click', onC);
    };
    const onP = () => {
      const save = showCheckbox ? document.getElementById('rd-save').checked : false;
      cleanup();
      resolve({ choice: 'primary', save });
    };
    const onS = () => { cleanup(); resolve({ choice: 'secondary' }); };
    const onC = () => { cleanup(); resolve({ choice: 'close' }); };

    primary.addEventListener('click', onP);
    secondary.addEventListener('click', onS);
    closeBtn.addEventListener('click', onC);
    dlg.querySelector('.rd-backdrop').addEventListener('click', onC);

    if (showCheckbox) {
      document.getElementById('rd-save').checked = true;
    }
    dlg.classList.remove('hidden');
  });
}

// ---- Mode toggle ----
async function enterReplay(opts = {}) {
  const App = window.App;
  if (!App || !App.currentBars.length) return;

  // If we have a saved replay for this symbol AND this call isn't already
  // a forced-restart, ask the user whether to continue or restart. Use the
  // async (server) loader so saves from other browsers/sessions show up too.
  const symbol = App.currentSymbol;
  const saved = await loadReplayStateAsync(symbol);
  let restoreCursor = null;
  if (saved && saved.cursorTimestamp && !opts.skipContinue) {
    const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
    const res = await showReplayDialog({
      title: t_('replay.dlgResumeTitle'),
      body:  t_('replay.dlgResumeBody'),
      primaryLabel:   t_('replay.dlgResumeContinue'),
      secondaryLabel: t_('replay.dlgResumeRestart'),
    });
    if (res.choice === 'primary') {
      restoreCursor = saved;
    } else if (res.choice === 'secondary') {
      clearReplayState(symbol);
    } else {
      // User dismissed — bail out without entering replay.
      return;
    }
  }

  Replay.baseBars = App.currentBars.slice();
  Replay.displayBars = Replay.baseBars.slice();   // start with full data, no cursor yet
  Replay.subBars = [];
  Replay.cursorIdx = 0;
  Replay.cursorTimestamp = null;
  Replay.maxCursorTs = null;       // §3.2.3 — fresh session, no future seen yet
  Replay.inProgressBar = null;
  Replay.tickHistory = [];
  Replay.displayTfMs = parseTfMs(App.currentTF);

  // Sub-TF dropdown: default to the display TF (one bar at a time, no interpolation).
  // User can pick a smaller TF for tick-style interpolation.
  syncSubTfOptions(App.currentTF);
  if (restoreCursor && restoreCursor.subTf) {
    const sel = document.getElementById('rep-subtf');
    if (sel && [...sel.options].some(o => o.value === restoreCursor.subTf)) {
      sel.value = restoreCursor.subTf;
    }
  }
  Replay.subTf = document.getElementById('rep-subtf').value;
  Replay.subTfMs = parseTfMs(Replay.subTf);

  Replay.active = true;
  document.getElementById('replay-bar').classList.remove('hidden');
  document.getElementById('btn-replay').classList.add('active');

  const status = document.getElementById('rep-status');
  if (restoreCursor) {
    // Set the cursor to the saved timestamp — same path as step-back's
    // rewind-past-pick flow, which handles both exact-bar and mid-bar cases.
    await setCursorAtTimestamp(restoreCursor.cursorTimestamp);
  } else if (status) {
    status.textContent = (window.I18n && window.I18n.t)
      ? window.I18n.t('replay.statusPickFirst')
      : '請按「選擇K線」並點擊圖表設定起點';
  }
  updateStatus();
}

// Sub-TF options: include all TFs <= display TF, default to display TF.
// Minutes use plain digits (no suffix, TradingView convention).
const ALL_SUB_TFS = ['1', '3', '5', '15', '30', '1h', '4h', '1d'];
function formatSubTfLabel(tf) {
  const m = tf.match(/^(\d+)([a-z]?)$/i);
  if (!m) return tf;
  return m[1] + (m[2] ? m[2].toUpperCase() : '');
}
function syncSubTfOptions(displayTf) {
  const sel = document.getElementById('rep-subtf');
  if (!sel) return;
  const dispMs = parseTfMs(displayTf);
  sel.innerHTML = '';
  for (const tf of ALL_SUB_TFS) {
    if (parseTfMs(tf) > dispMs) continue;
    const opt = document.createElement('option');
    opt.value = tf;
    opt.textContent = formatSubTfLabel(tf);
    if (tf === displayTf) opt.selected = true;
    sel.appendChild(opt);
  }
}

// User-triggered exit — shows the save/leave/stay dialog first.
async function exitReplay() {
  if (!Replay.active) { _doExitReplay(); return; }
  const App = window.App;
  const hasCursor = Number.isFinite(Replay.cursorTimestamp) && Replay.cursorTimestamp != null;
  // If user never picked a K-line, there's nothing worth saving — skip dialog.
  if (!hasCursor) { _doExitReplay(); return; }
  const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
  const res = await showReplayDialog({
    title: t_('replay.dlgExitTitle'),
    body:  t_('replay.dlgExitBody'),
    showCheckbox: true,
    checkboxLabel: t_('replay.dlgSaveSession'),
    primaryLabel:   t_('replay.dlgExit'),
    secondaryLabel: t_('replay.dlgStay'),
  });
  if (res.choice !== 'primary') return;        // stay / close → do nothing
  if (res.save && App && App.currentSymbol) {
    saveReplayState(App.currentSymbol, {
      cursorTimestamp: Replay.cursorTimestamp,
      tf: App.currentTF,
      subTf: Replay.subTf,
      savedAt: Date.now(),
    });
  } else if (App && App.currentSymbol) {
    // Explicit "don't save" — drop any prior save too.
    clearReplayState(App.currentSymbol);
  }
  _doExitReplay();
}

// Actual teardown — called after the user confirms (or directly on error paths).
function _doExitReplay() {
  pause();
  _showPlaceholderWicks();         // restore noChange wick/border colors
  Replay.active = false;
  Replay.picking = false;
  Replay.cursorTimestamp = null;
  Replay.maxCursorTs = null;       // §3.2.3 — clear future-seen flag on exit
  Replay.cursorBarIdx = 0;
  _partialCache.binStart = null;   // clear partial cache
  _partialCache.mins = [];
  _removePickOverlays();            // defined below (pick-mode visuals)
  const pickBtn = document.getElementById('rep-pick');
  if (pickBtn) pickBtn.classList.remove('active');
  document.getElementById('replay-bar').classList.add('hidden');
  document.getElementById('btn-replay').classList.remove('active');
  // Restore full data (removes LOOKAHEAD placeholders automatically).
  const App = window.App;
  if (App && App.currentBars.length) {
    Replay.chart.applyNewData(App.currentBars, App.currentBars.length >= 2000);
  }
  try { Replay.chart.setOffsetRightDistance(0); } catch (e) {}
  if (window.Drawing && window.Drawing.reanchorOverlaysWithDataIndex && App) {
    window.Drawing.reanchorOverlaysWithDataIndex(App.currentBars);
  }
}

// How much right-edge space is needed to render every overlay point past the
// cursor without horizontal compression. Computed from the overlay registry's
// max dataIndex vs the cursor position + barSpace.
function computeRequiredFog(displayBarIdx) {
  if (!window.Drawing || !window.Drawing.overlayRegistry) return Replay.FOG_PX;
  let maxIdx = displayBarIdx;
  for (const entry of window.Drawing.overlayRegistry.values()) {
    if (!entry.points) continue;
    for (const p of entry.points) {
      if (Number.isFinite(p.dataIndex) && p.dataIndex > maxIdx) maxIdx = p.dataIndex;
    }
  }
  const barsPast = Math.max(0, maxIdx - displayBarIdx);
  let barSpace = 8;
  try {
    const bs = Replay.chart.getBarSpace && Replay.chart.getBarSpace();
    barSpace = (typeof bs === 'object') ? (bs.bar || 8) : (bs || 8);
  } catch (e) {}
  // Small cushion so the rightmost glyph isn't flush to the edge.
  return Math.max(Replay.FOG_PX, Math.ceil(barsPast * barSpace) + 40);
}

async function setCursorAtBarIdx(displayBarIdx) {
  const cursorBar = Replay.baseBars[displayBarIdx];
  if (cursorBar) Replay.cursorTimestamp = cursorBar.timestamp;
  _bumpMaxCursorTs();
  Replay.tickHistory = [];
  Replay.inProgressBar = null;
  Replay.cursorBarIdx = displayBarIdx;

  // Fix the placeholder price to the last real bar's close — a single flat
  // line of invisible candles instead of a drifting doji scatter.
  const prevReal = Replay.baseBars[displayBarIdx - 1] || Replay.baseBars[displayBarIdx];
  Replay.placeholderFillPrice = (prevReal && Number.isFinite(prevReal.close))
    ? prevReal.close : 0;
  // Stretch placeholder high/low to recent real bars' range so Y-axis
  // autoscale stays stable when the user pans into placeholder territory.
  _computePlaceholderRange(displayBarIdx);
  _hidePlaceholderWicks();

  // New structure: real past bars + placeholder at cursor + placeholders for
  // EVERY remaining baseBar (plus LOOKAHEAD extra slots past the end). This
  // way any overlay whose points resolve to a baseBars dataIndex has a slot
  // in displayBars — otherwise KLineChart clamps the out-of-range point to
  // the last visible bar and the overlay "folds" onto a vertical line.
  const past = Replay.baseBars.slice(0, displayBarIdx);
  const placeholderCount =
    Math.max(1, Replay.baseBars.length - displayBarIdx) + LOOKAHEAD_BARS;
  const placeholders = makeFutureSlots(displayBarIdx, placeholderCount);
  Replay.displayBars = past.concat(placeholders);
  Replay.chart.applyNewData(Replay.displayBars);

  // No more fog — placeholders are IN the data, so offset-right can be tiny.
  try { Replay.chart.setOffsetRightDistance(40); } catch (e) {}

  // Scroll so the cursor bar sits 5 placeholders from the right edge —
  // TradingView convention (gives user breathing room to see what's next).
  try {
    if (Replay.chart.scrollToDataIndex) {
      Replay.chart.scrollToDataIndex(displayBarIdx + 5, 0);
    }
  } catch (e) { /* ignore */ }

  // Re-project every overlay's points with absolute dataIndex from baseBars.
  // Without dataIndex, KLineChart's timestamp→dataIndex binary search clamps
  // future-timestamp points to the last visible bar. With dataIndex set, the
  // coordinate math extrapolates them into the offset-right empty space.
  if (window.Drawing && window.Drawing.reanchorOverlaysWithDataIndex) {
    window.Drawing.reanchorOverlaysWithDataIndex(Replay.baseBars);
  }

  // Fetch sub-bars from cursor TS to end
  const startMs = Replay.baseBars[displayBarIdx].timestamp;
  const endMs = Replay.baseBars[Replay.baseBars.length - 1].timestamp + Replay.displayTfMs;
  try {
    Replay.subBars = await fetchSubBars(Replay.subTf, startMs, endMs);
  } catch (e) {
    console.error(e);
    Replay.subBars = [];
  }
  Replay.cursorIdx = 0;
  Replay._subBarsStale = false;
  updateStatus();
  _refreshMini();
  _markReplayDirty();
}

// Called by app.js when user switches TF while replay is active. Remap the
// cursor (a timestamp) onto the new TF's bars and re-apply the truncated view.
async function onTFChanged() {
  if (!Replay.active || !window.App) return;
  Replay.baseBars = window.App.currentBars.slice();
  Replay.displayTfMs = parseTfMs(window.App.currentTF);
  syncSubTfOptions(window.App.currentTF);
  Replay.subTf = document.getElementById('rep-subtf').value;
  Replay.subTfMs = parseTfMs(Replay.subTf);
  Replay.inProgressBar = null;
  Replay.tickHistory = [];      // clear undo stack — TF switch invalidates prior ticks
  _partialCache.binStart = null;     // TF change invalidates 1m cache (bin size changes)
  _partialCache.mins = [];
  pause();

  // No cursor picked yet → show full base bars, wait for pick
  if (!Replay.cursorTimestamp || !Replay.baseBars.length) {
    Replay.displayBars = Replay.baseBars.slice();
    Replay.subBars = [];
    Replay.cursorIdx = 0;
    Replay.chart.applyNewData(Replay.displayBars);
    updateStatus();
    return;
  }

  // Cursor out of the new TF's loaded range → ask user to re-pick
  if (Replay.cursorTimestamp < Replay.baseBars[0].timestamp) {
    Replay.cursorTimestamp = null;
    Replay.displayBars = Replay.baseBars.slice();
    Replay.subBars = [];
    Replay.cursorIdx = 0;
    Replay.chart.applyNewData(Replay.displayBars);
    const status = document.getElementById('rep-status');
    if (status) status.textContent = (window.I18n && window.I18n.t)
      ? window.I18n.t('replay.statusOutOfTf')
      : '游標超出新 TF 範圍，請重新「選擇K線」';
    return;
  }

  // Find bar CONTAINING the cursor: largest idx where baseBars[idx].ts ≤ cursor
  let containIdx = -1;
  for (let i = 0; i < Replay.baseBars.length; i++) {
    if (Replay.baseBars[i].timestamp > Replay.cursorTimestamp) break;
    containIdx = i;
  }
  if (containIdx < 0) containIdx = 0;
  const containBar = Replay.baseBars[containIdx];

  if (containBar.timestamp === Replay.cursorTimestamp) {
    // Cursor aligns exactly with bar start → seed-bar treatment.
    await setCursorAtBarIdx(containIdx);
  } else {
    // Cursor falls INSIDE containBar → partial bar. Build placeholders for
    // every remaining baseBar so overlays with far-future dataIndex stay
    // rendered (see setCursorAtBarIdx for the same rationale).
    const past = Replay.baseBars.slice(0, containIdx);
    const partial = await buildPartialBar(containBar.timestamp, Replay.cursorTimestamp);
    const slots = makeFutureSlots(containIdx,
      Math.max(1, Replay.baseBars.length - containIdx) + LOOKAHEAD_BARS);
    if (partial) slots[0] = partial;
    Replay.displayBars = past.concat(slots);
    Replay.cursorBarIdx = containIdx;
    const prevReal = Replay.baseBars[containIdx - 1] || Replay.baseBars[containIdx];
    Replay.placeholderFillPrice = (prevReal && Number.isFinite(prevReal.close))
      ? prevReal.close : 0;
    Replay.inProgressBar = partial || null;
    Replay.chart.applyNewData(Replay.displayBars, true);
    try { Replay.chart.setOffsetRightDistance(40); } catch (e) {}
    try {
      if (Replay.chart.scrollToDataIndex) {
        _setViewRightAt(Replay.chart, containIdx + 5);
      }
    } catch (e) { /* ignore */ }
    if (window.Drawing && window.Drawing.reanchorOverlaysWithDataIndex) {
      window.Drawing.reanchorOverlaysWithDataIndex(Replay.baseBars);
    }

    // Fetch sub-bars from cursor onwards (exclusive start → cursor itself
    // is NOT replayed again because the partial already represents it).
    const startMs = Replay.cursorTimestamp;
    const endMs = Replay.baseBars[Replay.baseBars.length - 1].timestamp + Replay.displayTfMs;
    try {
      Replay.subBars = await fetchSubBars(Replay.subTf, startMs, endMs);
    } catch (e) {
      console.error(e);
      Replay.subBars = [];
    }
    Replay.cursorIdx = 0;
    Replay._subBarsStale = false;
    updateStatus();
  }
}

// Binary-search baseBars for the largest bar.timestamp ≤ ts.
// Used to determine which display-TF bar a sub-bar aggregates into. This
// works for ET-aligned daily/weekly TFs where Math.floor(ts/86400000) gives
// the wrong boundary (UTC midnight instead of ET midnight).
function findDisplayBarStart(ts) {
  const bars = Replay.baseBars;
  if (!bars.length) return null;
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp > ts) hi = mid - 1;
    else lo = mid + 1;
  }
  return hi >= 0 ? bars[hi].timestamp : null;
}

// ---- Tick (advance one sub-bar) ----
// Scroll so dataIndex `targetIdx` lands at the right edge of the view.
// KLineChart's scrollToDataIndex overshoots by ceil(offsetRightDistance /
// barSpace) bars in this build, so we do one feedback pass to correct.
function _setViewRightAt(chart, targetIdx) {
  if (!chart || !chart.scrollToDataIndex || !chart.getVisibleRange) return;
  try { chart.scrollToDataIndex(targetIdx, 0); } catch (e) { return; }
  const v1 = chart.getVisibleRange();
  if (v1 && typeof v1.to === 'number' && v1.to !== targetIdx) {
    const delta = v1.to - targetIdx;
    try { chart.scrollToDataIndex(targetIdx - delta, 0); } catch (e) {}
  }
}

// ---- Placeholder Y-range hint ----------------------------------------
// Placeholders previously had open=high=low=close=placeholderFillPrice
// (a single flat price). When the user panned far right into the
// placeholder area, KLineChart's Y-axis autoscale collapsed because
// every visible bar carried the same single price.
//
// Fix: stretch placeholder high/low to encompass the recent real bars'
// price range. The Y-axis autoscale now sees that range whenever
// placeholders are visible, so panning right keeps the price scale
// stable. Body still sits at placeholderFillPrice (open === close), so
// visually the placeholder is just a thin horizontal line at fillPrice
// — same as before. The wicks (low → fillPrice → high) would normally
// render as visible vertical lines, so we override the global
// `noChangeWickColor` and `noChangeBorderColor` to transparent during
// replay (restored on exit). Trade-off: real doji bars (open === close
// EXACTLY) lose their wick rendering during replay, but doji is rare
// in tick-derived OHLC data, so this is an acceptable cosmetic loss.
function _computePlaceholderRange(fromIdx) {
  const N = 50;                      // last N real bars define the range
  const start = Math.max(0, fromIdx - N);
  const base = Replay.baseBars;
  let hi = -Infinity, lo = Infinity;
  for (let i = start; i < fromIdx; i++) {
    const b = base[i];
    if (!b) continue;
    if (Number.isFinite(b.high) && b.high > hi) hi = b.high;
    if (Number.isFinite(b.low)  && b.low  < lo) lo = b.low;
  }
  const fill = Replay.placeholderFillPrice;
  Replay.placeholderHigh = Number.isFinite(hi) ? hi : fill;
  Replay.placeholderLow  = Number.isFinite(lo) ? lo : fill;
}

let _candleStylesSaved = false;
function _hidePlaceholderWicks() {
  // Idempotent — only run once per replay session. Saved style snapshot
  // is restored on _doExitReplay via _showPlaceholderWicks.
  if (_candleStylesSaved || !Replay.chart || !Replay.chart.setStyles) return;
  _candleStylesSaved = true;
  try {
    Replay.chart.setStyles({
      candle: {
        bar: {
          noChangeWickColor:   'rgba(0,0,0,0)',
          noChangeBorderColor: 'rgba(0,0,0,0)',
        },
      },
    });
  } catch (e) { /* ignore */ }
}
function _showPlaceholderWicks() {
  if (!_candleStylesSaved || !Replay.chart || !Replay.chart.setStyles) return;
  _candleStylesSaved = false;
  try {
    // KLineChart 9.x defaults for noChange*: gray '#888'. Restoring that
    // mirrors what the chart looked like before replay started. (The
    // app.js init doesn't set noChange* explicitly, so this is the
    // effective baseline.)
    Replay.chart.setStyles({
      candle: {
        bar: {
          noChangeWickColor:   '#888888',
          noChangeBorderColor: '#888888',
        },
      },
    });
  } catch (e) { /* ignore */ }
}

function tick() {
  if (!Replay.active) return;
  if (Replay.cursorIdx >= Replay.subBars.length) {
    pause();
    return;
  }
  // Snapshot the visible range — applyNewData in this KLineChart build snaps
  // the view to the right edge, so we need to restore the user's zoom
  // position afterwards or the chart jumps forward on every tick.
  const _visBefore = Replay.chart.getVisibleRange && Replay.chart.getVisibleRange();
  const sub = Replay.subBars[Replay.cursorIdx++];
  const dispStart = findDisplayBarStart(sub.timestamp) ?? sub.timestamp;
  const curBar = Replay.displayBars[Replay.cursorBarIdx];
  const curTs = curBar ? curBar.timestamp : null;
  // "Same bar" when the sub-tick belongs to the bar currently at cursorBarIdx.
  // "New bar" when it belongs to a later display-bar slot — advance cursor.
  const isNewBar = curTs !== dispStart;

  Replay.tickHistory.push({
    cursorIdx: Replay.cursorIdx - 1,
    cursorTimestamp: Replay.cursorTimestamp,
    cursorBarIdx: Replay.cursorBarIdx,
    isNewBar,
    prevBar: curBar ? { ...curBar } : null,   // snapshot of cursorBarIdx BEFORE this tick
  });
  if (Replay.tickHistory.length > TICK_HISTORY_CAP) Replay.tickHistory.shift();

  if (isNewBar) {
    // Advance cursor to next slot — it was a placeholder, now it becomes the
    // in-progress bar seeded with this sub-tick's OHLC.
    Replay.cursorBarIdx++;
    const newBar = {
      timestamp: dispStart,
      open: sub.open, high: sub.high, low: sub.low,
      close: sub.close, volume: sub.volume,
    };
    Replay.displayBars[Replay.cursorBarIdx] = newBar;
    Replay.inProgressBar = newBar;
    // Maintain LOOKAHEAD: push one more placeholder at the end. Reuse the
    // fixed Replay.placeholderFillPrice + placeholderHigh/Low so all
    // placeholders stay at the same level visually (one flat line) AND
    // contribute the same Y-range hint (recent real bars' high/low) so
    // KLineChart's autoscale stays stable even when the user pans far
    // right into the placeholder zone.
    const lastBar = Replay.displayBars[Replay.displayBars.length - 1];
    const tfMs = Replay.displayTfMs || 60000;
    const nextTs = (lastBar ? lastBar.timestamp : dispStart) + tfMs;
    const fillPrice = Replay.placeholderFillPrice || newBar.close || 0;
    const phHigh = Number.isFinite(Replay.placeholderHigh) ? Replay.placeholderHigh : fillPrice;
    const phLow  = Number.isFinite(Replay.placeholderLow)  ? Replay.placeholderLow  : fillPrice;
    Replay.displayBars.push({
      timestamp: nextTs,
      open: fillPrice, close: fillPrice,
      high: phHigh,    low: phLow,
      volume: 0, _placeholder: true,
    });
    // Tick-rate redraw: the data array is mutated in place above, so
    // we just need a layout pass — NOT applyNewData(Init) which would
    // wipe crosshair + reset view (= flicker + drag-fight per tick).
    // barsAdded=true because we pushed a new placeholder.
    if (!_redrawTickInPlace(true)) {
      Replay.chart.applyNewData(Replay.displayBars, false);
    }
  } else {
    // Same bar — aggregate or initialize placeholder in place.
    if (isPlaceholderBar(curBar)) {
      curBar.open = sub.open;
      curBar.high = sub.high;
      curBar.low  = sub.low;
      curBar.close = sub.close;
      curBar.volume = sub.volume;
      delete curBar._placeholder;
    } else {
      curBar.high = Math.max(curBar.high, sub.high);
      curBar.low  = Math.min(curBar.low,  sub.low);
      curBar.close  = sub.close;
      curBar.volume = (curBar.volume || 0) + sub.volume;
    }
    Replay.inProgressBar = curBar;
    // Same in-place redraw — `displayBars[cursorBarIdx]` was mutated
    // (cur bar's OHLC) and KLineChart's _dataList is the same array.
    // barsAdded=false (no structural change, just OHLC mutation).
    if (!_redrawTickInPlace(false)) {
      Replay.chart.applyNewData(Replay.displayBars, false);
    }
  }

  const nextSub = Replay.subBars[Replay.cursorIdx];
  Replay.cursorTimestamp = nextSub ? nextSub.timestamp : (sub.timestamp + Replay.subTfMs);
  _bumpMaxCursorTs();

  // After applyNewData KLineChart reindexes overlay points by timestamp. Any
  // point with a "future" timestamp (placeholders or past-end projections)
  // collapses onto the last real bar unless we re-inject absolute dataIndex.
  if (window.Drawing && window.Drawing.reanchorOverlaysWithDataIndex) {
    window.Drawing.reanchorOverlaysWithDataIndex(Replay.baseBars);
  }

  // Sim engine tick: feed the (now-updated) in-progress bar to the order
  // matcher so pending limits/stops fire intra-replay. Step 7 will swap
  // this for proper sub-bar tick streaming; step 2 reuses the cursor's
  // display-TF bar, which is good enough to verify the panel works.
  if (window.SimController && window.SimController.onReplayTick) {
    window.SimController.onReplayTick();
  }

  // View-follow logic: keep cursor visible when it's near the right edge,
  // otherwise let the user's pan position stand.
  //
  // Old (legacy applyNewData) path snapped view to far right on every tick
  // and we had to RESTORE either to follow-cursor or to user's pre-snap
  // pan. The new in-place redraw path doesn't snap view — we only need to
  // ACTIVELY follow when cursor is approaching the edge. The "cursor has
  // room → freeze" case becomes a no-op (view is already where user left it).
  //
  // `scrollToDataIndex(N)` in this KLineChart build overshoots by a few bars
  // (depends on offsetRightDistance / barSpace). _setViewRightAt corrects
  // with one feedback pass.
  if (_visBefore && Replay.chart.getVisibleRange && Replay.chart.scrollToDataIndex) {
    const _visAfter = Replay.chart.getVisibleRange();
    const FOLLOW_OFFSET = 5;
    const keepOffset = _visBefore.to - Replay.cursorBarIdx;
    if (keepOffset < FOLLOW_OFFSET) {
      // Cursor near (or past) the right edge — scroll to keep it visible.
      _setViewRightAt(Replay.chart, Replay.cursorBarIdx + FOLLOW_OFFSET);
    } else if (_visAfter && _visAfter.from !== _visBefore.from) {
      // View drifted but cursor has room → restore user's pan position.
      // (Triggers on the legacy applyNewData fallback path; the in-place
      // redraw path leaves _visAfter.from === _visBefore.from so this is
      // a no-op.)
      _setViewRightAt(Replay.chart, _visBefore.to);
    }
  }

  updateStatus();
  _refreshMini();
  _markReplayDirty();
}

// ---- Step back (undo one tick or rewind past pick) ----
// Two modes:
//   - Fast path: if we have forward ticks in tickHistory, pop one.
//   - Slow path: once back at the pick position (tickHistory empty), keep
//     rewinding by moving the cursor back one subTf step — shrinks the
//     displayed history by one sub-bar / partial slice.

/** Predict where the cursor *would* land after stepBack runs. Used by
 *  the danger-zone check before showing the fork-or-discard modal so
 *  we know what cutoff to feed it. Returns the predicted cursor
 *  timestamp, or null if we can't determine it. */
function _predictPostStepCursorTs() {
  if (Replay.tickHistory && Replay.tickHistory.length > 0) {
    return Replay.tickHistory[Replay.tickHistory.length - 1].cursorTimestamp;
  }
  if (Number.isFinite(Replay.cursorTimestamp) && Number.isFinite(Replay.subTfMs)) {
    return Replay.cursorTimestamp - Replay.subTfMs;
  }
  return null;
}

/** List trades on the ACTIVE branch that fall past `cutoffTs` —
 *  positions whose entry OR exit landed after the cutoff (the trade
 *  "exists in the danger zone"). Used by stepBack to decide whether
 *  to prompt the user. */
function _tradesAfterCutoff(cutoffTs) {
  if (!Number.isFinite(cutoffTs)) return [];
  const Eng = window.BranchEngine;
  if (!Eng || !Eng.getOwnTrades) return [];
  const activeId = Eng.activeBranchId || 'main';
  const own = Eng.getOwnTrades(activeId) || [];
  return own.filter(p => {
    const opened = Number.isFinite(p.openedAtBarTs) && p.openedAtBarTs > cutoffTs;
    const closed = Number.isFinite(p.closedAtBarTs) && p.closedAtBarTs > cutoffTs;
    return opened || closed;
  });
}

/** Show the fork-or-discard modal and act on the result. Returns
 *  true if the caller should proceed with the actual stepBack work,
 *  false if the user cancelled (cursor stays put).
 *
 *  - 'fork'    → create a new branch at `cutoffTs` (engine state is
 *                left intact, so the trades become the new branch's
 *                own history). Active branch is switched to it.
 *  - 'discard' → engine.rollbackToBarTs(cutoffTs) wipes the trades
 *                from the active branch.
 *  - cancel    → noop. */
async function _handleStepBackThroughTrades(cutoffTs, trades) {
  const Modals = window.BranchModals;
  const Engine = window.BranchEngine;
  if (!Modals || !Modals.forkOrDiscard || !Engine) {
    // Fallback: no modal infrastructure → just step back silently.
    return true;
  }

  // Pre-compute summary numbers for the modal stat block.
  let netPnL = 0;
  for (const p of trades) {
    if (Number.isFinite(p.realisedPnL))    netPnL += p.realisedPnL;
    if (Number.isFinite(p.commissionPaid)) netPnL -= p.commissionPaid;
  }
  const sign = netPnL >= 0 ? '+' : '−';
  const netPnLLabel = `${sign}$${Math.abs(netPnL).toFixed(2)}`;
  // Last trade by openedAtBarTs (most recent entry in the danger zone).
  const lastTrade = trades.slice().sort((a, b) =>
    (b.openedAtBarTs || 0) - (a.openedAtBarTs || 0))[0];
  const t_ = (k, vars) => (window.I18n && window.I18n.t) ? window.I18n.t(k, vars) : k;
  const lastTradeSummary = lastTrade
    ? `${lastTrade.side === 'long' ? t_('sim.posSideLong') : t_('sim.posSideShort')} ${lastTrade.qty} @ ${lastTrade.avgEntryPrice ? lastTrade.avgEntryPrice.toFixed(2) : '?'}`
    : '';

  const activeBranch = Engine.getBranch
    ? Engine.getBranch(Engine.activeBranchId)
    : null;
  // Spec §4.4 — auto-default "主線" → "Main"; user-renamed verbatim.
  const parentName = !activeBranch
    ? t_('branch.kindMain')
    : (activeBranch.kind === 'main' && (activeBranch.name === '主線' || activeBranch.name === 'Main')
        ? t_('branch.kindMain') : activeBranch.name);
  const tsLabel = t_('branch.barLabel', { n: '?' });
  const defaultName = `branch-${(Engine.getBranches ? Engine.getBranches().length : 1)}`;

  const result = await Modals.forkOrDiscard({
    parentName,
    forkBarLabel: tsLabel,
    forkBarTimestamp: cutoffTs,
    defaultName,
    tradeCount: trades.length,
    netPnLLabel,
    lastTradeSummary,
  });

  if (!result.confirmed) return false;
  if (result.action === 'fork') {
    // Create a new branch at the cutoff. Trades stay on their
    // original branch; the new branch starts empty (the user can
    // continue from cursor going forward).
    if (Engine.createBranch && Engine.setActiveBranch) {
      const branch = Engine.createBranch({
        name: result.name,
        kind: result.kind,
        parentId: Engine.activeBranchId,
        forkBarTimestamp: cutoffTs,
        note: result.note,
      });
      if (branch && branch.id) Engine.setActiveBranch(branch.id);
    }
    return true;
  }
  if (result.action === 'discard') {
    const eng = (window.SimController && window.SimController.engine) || null;
    if (eng && eng.rollbackToBarTs) {
      eng.rollbackToBarTs(cutoffTs);
      // Refresh the panel + canvas overlays so the wiped trades
      // disappear from the chart immediately.
      if (window.SimPanel    && window.SimPanel.refresh) window.SimPanel.refresh();
      if (window.SimOverlays && window.SimOverlays.sync) window.SimOverlays.sync();
    }
    return true;
  }
  return false;
}
async function stepBack() {
  if (!Replay.active) return;
  pause();

  // branching-replay-spec §3.1 (Phase 3) — if any trades exist on the
  // active branch with `executedAtBar > newCursorTs`, prompt the user
  // to fork or discard before stepping back. Suppress while a previous
  // prompt is still in flight (rapid `,` press).
  if (Replay._forkDiscardPending) return;
  // Predict the post-step cursor without mutating state. The new
  // cursor is whatever the most-recent tickHistory entry's
  // `cursorTimestamp` was, OR (slow path) cursor − subTfMs.
  const newCursorTs = _predictPostStepCursorTs();
  if (Number.isFinite(newCursorTs)) {
    const trades = _tradesAfterCutoff(newCursorTs);
    if (trades.length > 0) {
      Replay._forkDiscardPending = true;
      try {
        const handled = await _handleStepBackThroughTrades(newCursorTs, trades);
        if (!handled) return;     // user cancelled — leave cursor where it was
      } finally {
        Replay._forkDiscardPending = false;
      }
    }
  }

  // Same scroll-preservation guard as tick() — this KLineChart build snaps
  // the view to the right edge on applyNewData, which makes every step jump
  // the chart forward.
  const _visBefore = Replay.chart.getVisibleRange && Replay.chart.getVisibleRange();
  const _cursorBefore = Replay.cursorBarIdx;

  if (Replay.tickHistory.length) {
    const h = Replay.tickHistory.pop();
    Replay.cursorIdx = h.cursorIdx;
    Replay.cursorTimestamp = h.cursorTimestamp;
    // _bumpMaxCursorTs is monotonic — backward jump is a no-op, but keep
    // the call here so every cursor mutation has the bump alongside it.
    _bumpMaxCursorTs();
    if (h.isNewBar) {
      // Undo "advance cursor": turn the just-placed bar back into a
      // placeholder and drop cursorBarIdx to its pre-advance value.
      const placeTs = Replay.displayBars[Replay.cursorBarIdx].timestamp;
      const fillPrice = Replay.placeholderFillPrice || 0;
      const phHigh = Number.isFinite(Replay.placeholderHigh) ? Replay.placeholderHigh : fillPrice;
      const phLow  = Number.isFinite(Replay.placeholderLow)  ? Replay.placeholderLow  : fillPrice;
      Replay.displayBars[Replay.cursorBarIdx] = {
        timestamp: placeTs,
        open: fillPrice, close: fillPrice,
        high: phHigh,    low: phLow,
        volume: 0, _placeholder: true,
      };
      Replay.cursorBarIdx = h.cursorBarIdx;
      Replay.displayBars.pop();
    } else {
      // Undo in-place aggregation: restore prior OHLC at cursorBarIdx.
      Replay.cursorBarIdx = h.cursorBarIdx;
      if (h.prevBar) {
        Replay.displayBars[Replay.cursorBarIdx] = { ...h.prevBar };
      }
    }
    const active = Replay.displayBars[Replay.cursorBarIdx];
    Replay.inProgressBar = isPlaceholderBar(active) ? null : active;
    Replay.chart.applyNewData(Replay.displayBars, false);
    if (window.Drawing && window.Drawing.reanchorOverlaysWithDataIndex) {
      window.Drawing.reanchorOverlaysWithDataIndex(Replay.baseBars);
    }
    // Sim engine: re-render the panel & overlays. We don't replay the
    // tick into the engine (that would double-fill); we just refresh
    // the UI based on the now-restored bar state.
    if (window.SimPanel && window.SimPanel.refresh) window.SimPanel.refresh();
    if (window.SimOverlays && window.SimOverlays.sync) window.SimOverlays.sync();
    // Step-back: cursor stays at its current pixel position within the view,
    // so the view shifts by exactly the cursor delta (−1 for isNewBar undo,
    // 0 for in-place undo). One press = one visible unit of backward travel.
    if (_visBefore && Replay.chart.getVisibleRange && Replay.chart.scrollToDataIndex) {
      const cursorDelta = Replay.cursorBarIdx - _cursorBefore;
      const targetTo = _visBefore.to + cursorDelta;
      const _visAfter = Replay.chart.getVisibleRange();
      if (_visAfter && (_visAfter.from !== _visBefore.from || cursorDelta !== 0)) {
        _setViewRightAt(Replay.chart, targetTo);
      }
    }
    updateStatus();
    return;
  }

  // Rewind past pick: cursor moves back by one sub-TF step
  if (Replay.cursorTimestamp == null || !Replay.baseBars.length) return;
  const newTs = Replay.cursorTimestamp - Replay.subTfMs;
  if (newTs < Replay.baseBars[0].timestamp) return;
  await setCursorAtTimestamp(newTs, { snapView: false });
  // Cursor-delta-based view shift — same behavior as fast-path so the user's
  // pan/zoom position survives rapid stepBack presses.
  if (_visBefore && Replay.chart.getVisibleRange && Replay.chart.scrollToDataIndex) {
    const cursorDelta = Replay.cursorBarIdx - _cursorBefore;
    const targetTo = _visBefore.to + cursorDelta;
    _setViewRightAt(Replay.chart, targetTo);
  }
  _refreshMini();
  _markReplayDirty();
}

// Generic cursor setter — used by the rewind-past-pick path.
// Uses a request counter to cancel stale work: when the user presses `,`
// repeatedly, in-flight buildPartialBar/fetchSubBars calls from earlier
// presses can resolve AFTER later ones started, and racing pushes to
// displayBars would stack partial bars on top of each other. Checking
// reqId after every await makes only the latest call commit state.
let _cursorReqCounter = 0;

async function setCursorAtTimestamp(ts, opts = {}) {
  const { snapView = true } = opts;
  const reqId = ++_cursorReqCounter;

  const dispStart = findDisplayBarStart(ts);
  if (dispStart == null) return;
  let idx = -1;
  for (let i = 0; i < Replay.baseBars.length; i++) {
    if (Replay.baseBars[i].timestamp === dispStart) { idx = i; break; }
  }
  if (idx < 0) return;

  // Compute partial BEFORE mutating state so we can abandon if stale
  let partial = null;
  if (dispStart !== ts) {
    partial = await buildPartialBar(dispStart, ts);
    if (reqId !== _cursorReqCounter) return;  // a newer stepBack has started
  }

  // Commit state (synchronous section — safe from race)
  Replay.cursorTimestamp = ts;
  _bumpMaxCursorTs();
  Replay.tickHistory = [];
  Replay.cursorBarIdx = idx;
  const prevReal2 = Replay.baseBars[idx - 1] || Replay.baseBars[idx];
  Replay.placeholderFillPrice = (prevReal2 && Number.isFinite(prevReal2.close))
    ? prevReal2.close : 0;
  // Recompute placeholder Y-range hint + ensure wick-hide style is applied
  // on the restore-from-save path (which doesn't go through setCursorAtBarIdx).
  _computePlaceholderRange(idx);
  _hidePlaceholderWicks();
  const past = Replay.baseBars.slice(0, idx);
  // Cursor slot + placeholders for every remaining baseBar + LOOKAHEAD past
  // the end (see setCursorAtBarIdx for why we cover the full baseBars range).
  const slots = makeFutureSlots(idx,
    Math.max(1, Replay.baseBars.length - idx) + LOOKAHEAD_BARS);
  if (partial) slots[0] = partial;                  // replace cursor-slot placeholder
  Replay.displayBars = past.concat(slots);
  Replay.inProgressBar = partial || null;
  Replay.chart.applyNewData(Replay.displayBars, true);
  try { Replay.chart.setOffsetRightDistance(40); } catch (e) {}
  // Position cursor 5 placeholders from the right edge — matches the
  // setCursorAtBarIdx pick flow. Callers doing small cursor adjustments
  // (stepBack slow-path) pass {snapView:false} and handle their own scroll
  // so the user's panned/zoomed view doesn't keep getting reset.
  if (snapView) {
    try {
      if (Replay.chart.scrollToDataIndex) {
        _setViewRightAt(Replay.chart, idx + 5);
      }
    } catch (e) { /* ignore */ }
  }
  if (window.Drawing && window.Drawing.reanchorOverlaysWithDataIndex) {
    window.Drawing.reanchorOverlaysWithDataIndex(Replay.baseBars);
  }

  // Mark subBars stale — actual fetch is deferred until user presses play or
  // `.` (see ensureSubBarsReady). This keeps rapid stepBack presses purely
  // local (cached partial + chart.applyNewData).
  Replay._subBarsStale = true;
  Replay.cursorIdx = 0;
  // Refresh sim overlays — cursor jumped, trades that were visible may
  // now be "in the future" per branching-replay-spec §2.1's replay
  // cursor filter. _syncTradeArrows reads Replay.cursorTimestamp on
  // each call so simply triggering a sync is enough.
  if (window.SimOverlays && window.SimOverlays.sync) window.SimOverlays.sync();
  if (window.SimPanel && window.SimPanel.refresh) window.SimPanel.refresh();
  updateStatus();
  _refreshMini();
  _markReplayDirty();
}

// Call before any forward-tick operation (play / .). If the cached subBars
// don't start at the current cursor, re-fetch them. Rapid successive calls
// SHARE the same in-flight promise (dedup) — without this, rapid `.` presses
// would fire N parallel HTTP requests that race and overwrite each other.
let _subBarsFetchPromise = null;

async function ensureSubBarsReady() {
  // Ready when: not flagged stale AND we still have unplayed sub-bars ahead
  // of cursorIdx. (cursorTimestamp advances on every tick; comparing it to
  // subBars[0].timestamp would always refetch after the first tick.)
  if (!Replay._subBarsStale
      && Replay.subBars.length
      && Replay.cursorIdx < Replay.subBars.length) {
    return;
  }
  if (_subBarsFetchPromise) {
    await _subBarsFetchPromise;
    return;
  }
  const cursorAtStart = Replay.cursorTimestamp;
  _subBarsFetchPromise = (async () => {
    const endMs = Replay.baseBars[Replay.baseBars.length - 1].timestamp + Replay.displayTfMs;
    try {
      const subs = await fetchSubBars(Replay.subTf, cursorAtStart, endMs);
      // If cursor moved during the fetch, this result is stale — discard.
      if (cursorAtStart === Replay.cursorTimestamp) {
        Replay.subBars = subs;
        Replay.cursorIdx = 0;
        Replay._subBarsStale = false;
      }
    } catch (e) {
      console.error(e);
      if (cursorAtStart === Replay.cursorTimestamp) Replay.subBars = [];
    } finally {
      _subBarsFetchPromise = null;
    }
  })();
  await _subBarsFetchPromise;
}

// Re-fetch sub-bars using current cursorTimestamp + subTf. Does NOT mutate
// cursorTimestamp, displayBars, or inProgressBar — call after changing subTf.
async function refreshSubBars() {
  if (!Replay.cursorTimestamp || !Replay.baseBars.length) return;
  const startMs = Replay.cursorTimestamp;
  const endMs = Replay.baseBars[Replay.baseBars.length - 1].timestamp + Replay.displayTfMs;
  try {
    Replay.subBars = await fetchSubBars(Replay.subTf, startMs, endMs);
  } catch (e) {
    console.error(e);
    Replay.subBars = [];
  }
  Replay.cursorIdx = 0;
  updateStatus();
}

// Cache: 1-min bars covering one display-TF bin. Fetched once per bin so
// that rapid stepBack within the same bin (e.g. 1m sub inside a 15m bar)
// rebuilds the partial bar synchronously — no HTTP round-trip per press.
const _partialCache = { binStart: null, mins: [] };

// Build a partial display-TF bar by aggregating 1-min data from `binStart`
// (the display-TF bar's start timestamp) up to but NOT including `cursorTs`.
// Returned bar has timestamp=binStart so subsequent ticks will aggregate
// into it (their findDisplayBarStart maps to the same binStart).
async function buildPartialBar(binStart, cursorTs) {
  if (_partialCache.binStart !== binStart) {
    const binEnd = binStart + Replay.displayTfMs;
    try {
      _partialCache.mins = await fetchSubBars('1', binStart, binEnd - 1);
      _partialCache.binStart = binStart;
    } catch (e) {
      console.error('[buildPartialBar]', e);
      _partialCache.binStart = null;
      _partialCache.mins = [];
      return null;
    }
  }
  const bars = _partialCache.mins.filter(b =>
    b.timestamp >= binStart && b.timestamp < cursorTs);
  if (!bars.length) return null;
  let high = bars[0].high, low = bars[0].low, volume = 0;
  for (const b of bars) {
    if (b.high > high) high = b.high;
    if (b.low  < low)  low  = b.low;
    volume += b.volume;
  }
  return {
    timestamp: binStart,
    open:   bars[0].open,
    high, low,
    close:  bars[bars.length - 1].close,
    volume,
  };
}

function jumpToEnd() {
  while (Replay.cursorIdx < Replay.subBars.length) tick();
}

// Lock / unlock chart horizontal pan for the duration of playback.
// Per user request: any horizontal drag during play creates visible
// jitter (ticks fight with user-driven view changes). Cleanest fix is
// to disable pan while playing — user pauses (space) to scroll back
// through history. Zoom (mouse wheel) is intentionally left enabled —
// the user can still adjust bar density during playback.
function _setChartInteractionLocked(locked) {
  const chart = Replay.chart;
  if (!chart) return;
  try {
    if (typeof chart.setScrollEnabled === 'function') chart.setScrollEnabled(!locked);
  } catch (e) { /* ignore */ }
}

// ---- Play / pause ----
async function play() {
  if (!Replay.active || Replay.playing) return;
  await ensureSubBarsReady();
  if (!Replay.active) return;                 // user may have exited while we awaited
  Replay.playing = true;
  _setChartInteractionLocked(true);
  Replay.intervalHandle = setInterval(tick, tickIntervalMs());
  updatePlayIcon();
}

function pause() {
  Replay.playing = false;
  _setChartInteractionLocked(false);
  if (Replay.intervalHandle) {
    clearInterval(Replay.intervalHandle);
    Replay.intervalHandle = null;
  }
  updatePlayIcon();
}

function togglePlay() {
  if (Replay.playing) pause();
  else play();
}

function updatePlayIcon() {
  const icon = document.getElementById('rep-play-icon');
  if (Replay.playing) {
    icon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  } else {
    icon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
  }
}

function updateStatus() {
  const el = document.getElementById('rep-status');
  if (!el) return;
  if (!Replay.active) { el.textContent = ''; return; }
  const remaining = Replay.subBars.length - Replay.cursorIdx;
  // Status format not in spec §3.3 master dictionary — translate inline.
  // zh: "T · 剩 N subTf"  /  en: "T · N subTf left"
  const lang = (window.I18n && window.I18n.lang) || 'zh';
  if (Replay.inProgressBar) {
    const t = new Date(Replay.inProgressBar.timestamp);
    const tStr = t.toISOString().replace('T', ' ').slice(0, 16);
    el.textContent = lang === 'en'
      ? `${tStr}  ·  ${remaining} ${Replay.subTf} left`
      : `${tStr}  ·  剩 ${remaining} ${Replay.subTf}`;
  } else {
    el.textContent = lang === 'en'
      ? `Ready  ·  ${remaining} ${Replay.subTf} pending`
      : `準備就緒  ·  ${remaining} ${Replay.subTf} 待播`;
  }
}

// ---- Pick mode (click chart to set cursor) ----
// Visual feedback (TradingView-style): scissor cursor + the chart's native
// crosshair restyled to a solid blue vertical line (so we still get its time
// tooltip on the x-axis) + a dim overlay covering bars to the right.
let _pickDim = null;
let _pickDimMini = null;          // mirror dim inside #mini-chart so the
                                  // sub-chart also visually hides bars
                                  // past the picked cursor.
let _pickMouseMoveHandler = null;
let _pickContextHandler = null;
let _savedCrosshairStyles = null;

function _ensurePickOverlays() {
  const area = document.getElementById('chart-area');
  if (!area) return null;
  if (!_pickDim) {
    _pickDim = document.createElement('div');
    _pickDim.className = 'pick-dim';
    area.appendChild(_pickDim);
  }
  // If the mini chart is open, mirror the dim onto it. Mini-side dim
  // has its own per-chart pixel computation in `_updatePickOverlay`
  // (mini's yAxis width / offsetRight may differ from main's, so we
  // can't just reuse the main snappedX directly).
  const miniBody = document.getElementById('mini-chart');
  const miniPanel = document.getElementById('mini-chart-panel');
  if (miniBody && miniPanel && !miniPanel.hidden && !_pickDimMini) {
    _pickDimMini = document.createElement('div');
    _pickDimMini.className = 'pick-dim';
    miniBody.appendChild(_pickDimMini);
  }
  return area;
}

function _removePickOverlays() {
  if (_pickDim) { _pickDim.remove(); _pickDim = null; }
  if (_pickDimMini) { _pickDimMini.remove(); _pickDimMini = null; }
  if (_pickMouseMoveHandler) {
    document.removeEventListener('mousemove', _pickMouseMoveHandler);
    _pickMouseMoveHandler = null;
  }
  if (_pickContextHandler) {
    const area = document.getElementById('chart-area');
    if (area) area.removeEventListener('contextmenu', _pickContextHandler, true);
    _pickContextHandler = null;
  }
  document.body.classList.remove('replay-picking');
}

// Align the pick line to KLineChart's bar-snapped crosshair position so
// they don't drift apart as the mouse moves between bars.
let _crosshairSubscribed = false;

// Apply/restore crosshair styling so the vertical line is a solid blue ruler
// while picking, but horizontal + tooltip stay hidden to declutter.
function _applyPickCrosshair() {
  try {
    // Snapshot current crosshair styles so we can restore them on exit.
    if (Replay.chart.getStyles) {
      const s = Replay.chart.getStyles();
      if (s && s.crosshair) _savedCrosshairStyles = JSON.parse(JSON.stringify(s.crosshair));
    }
    Replay.chart.setStyles({
      crosshair: {
        show: true,
        vertical: {
          line: { color: '#2962ff', style: 'solid', size: 2 },
        },
        // Hide the horizontal crosshair line while picking — the user only
        // needs the vertical ruler + date label.
        horizontal: { show: false },
      },
    });
  } catch (e) { /* ignore */ }
}

function _restorePickCrosshair() {
  try {
    if (_savedCrosshairStyles) {
      Replay.chart.setStyles({ crosshair: _savedCrosshairStyles });
    } else {
      // Fallback default.
      Replay.chart.setStyles({
        crosshair: {
          show: true,
          vertical: { line: { color: '#888', style: 'dashed', size: 1 } },
          horizontal: { show: true, line: { color: '#888', style: 'dashed', size: 1 } },
        },
      });
    }
  } catch (e) { /* ignore */ }
  _savedCrosshairStyles = null;
}

// If replay already has a cursor, re-picking can only go BACKWARD — return
// the pixel X of the current cursor bar so the pick line can be clamped.
function _pickMaxX() {
  if (!Replay.chart || !Number.isFinite(Replay.cursorBarIdx)) return null;
  if (Replay.cursorBarIdx <= 0) return null;    // no cursor yet — no clamp
  try {
    const bar = Replay.displayBars[Replay.cursorBarIdx];
    if (!bar) return null;
    const px = Replay.chart.convertToPixel(
      [{ dataIndex: Replay.cursorBarIdx, value: bar.close }],
      { paneId: 'candle_pane' });
    if (Array.isArray(px) && px[0] && Number.isFinite(px[0].x)) return px[0].x;
  } catch (e) {}
  return null;
}

function _updatePickOverlay(snappedX) {
  if (!_pickDim) return;
  const area = document.getElementById('chart-area');
  if (!area) return;
  const rect = area.getBoundingClientRect();
  // Clamp to [0, maxX] so user can't pick past the current replay cursor.
  const maxX = _pickMaxX();
  if (snappedX == null) snappedX = 0;
  if (maxX != null && snappedX > maxX) snappedX = maxX;
  if (snappedX < 0 || snappedX > rect.width) {
    _pickDim.style.display = 'none';
    if (_pickDimMini) _pickDimMini.style.display = 'none';
    return;
  }
  _pickDim.style.display = 'block';
  _pickDim.style.left  = (snappedX + 2) + 'px';
  _pickDim.style.width = Math.max(0, rect.width - snappedX - 2) + 'px';

  _updateMiniPickDim(snappedX);
}

/** Mirror the pick-dim onto the mini chart. Main + mini are
 *  viewport-sync'd (same barSpace + same right-edge dataIndex +
 *  same offsetRight), and chart-area / mini-chart share the same
 *  X origin (both flex children of #main with no left padding), so
 *  the same bar sits at the same X on both — we can reuse the
 *  main-side snappedX directly. Lazy-creates _pickDimMini if the
 *  user opens the mini AFTER pick mode started. */
function _updateMiniPickDim(snappedX) {
  const Mini = window.MiniChart;
  const miniBody = document.getElementById('mini-chart');
  const miniPanel = document.getElementById('mini-chart-panel');
  const miniOpen = !!(Mini && Mini.chart && miniPanel && !miniPanel.hidden && miniBody);
  if (!miniOpen) {
    if (_pickDimMini) { _pickDimMini.remove(); _pickDimMini = null; }
    return;
  }
  if (!_pickDimMini) {
    _pickDimMini = document.createElement('div');
    _pickDimMini.className = 'pick-dim';
    miniBody.appendChild(_pickDimMini);
  }
  const miniRect = miniBody.getBoundingClientRect();
  if (snappedX < 0 || snappedX > miniRect.width) {
    _pickDimMini.style.display = 'none';
    return;
  }
  _pickDimMini.style.display = 'block';
  _pickDimMini.style.left  = (snappedX + 2) + 'px';
  _pickDimMini.style.width = Math.max(0, miniRect.width - snappedX - 2) + 'px';
}

function _cancelPick() {
  if (!Replay.picking) return;
  Replay.picking = false;
  _removePickOverlays();
  _restorePickCrosshair();
  document.getElementById('rep-pick').classList.remove('active');
  const s = document.getElementById('rep-status');
  if (s) s.textContent = '';
}

function enterPickMode() {
  if (!Replay.active) return;
  // Second click cancels.
  if (Replay.picking) { _cancelPick(); return; }
  Replay.picking = true;
  document.body.classList.add('replay-picking');
  document.getElementById('rep-pick').classList.add('active');
  const status = document.getElementById('rep-status');
  if (status) status.textContent = (window.I18n && window.I18n.t)
    ? window.I18n.t('replay.statusPickClick')
    : '請點擊圖表設定起點（左鍵確定｜右鍵取消）';

  // Restyle the native crosshair: solid blue vertical ruler (keeps the
  // x-axis date/time tooltip intact); horizontal line hidden.
  _applyPickCrosshair();

  const area = _ensurePickOverlays();
  if (!area) return;

  // Primary: use KLineChart's own crosshair x (bar-snapped) so the pick line
  // tracks EXACTLY with the dashed crosshair, no horizontal drift.
  if (!_crosshairSubscribed && Replay.chart && Replay.chart.subscribeAction) {
    try {
      Replay.chart.subscribeAction('onCrosshairChange', (data) => {
        if (!Replay.picking) return;
        // data.x is relative to the chart canvas. We need it relative to
        // #chart-area (same origin — chart fills chart-area).
        if (data && Number.isFinite(data.x)) _updatePickOverlay(data.x);
      });
      _crosshairSubscribed = true;
    } catch (e) { /* fallback below still works */ }
  }

  // Fallback: mousemove snapped to the nearest bar via convertFromPixel →
  // convertToPixel, so even when KLineChart's crosshair event stays silent
  // (crosshair hidden), the pick line still snaps to bar centers like TV.
  _pickMouseMoveHandler = (e) => {
    if (!Replay.picking) return;
    const rect = area.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let snapX = x;
    try {
      const pt = Replay.chart.convertFromPixel(
        { x, y: 0 }, { paneId: 'candle_pane' });
      const p = Array.isArray(pt) ? pt[0] : pt;
      if (p && Number.isFinite(p.dataIndex)) {
        const back = Replay.chart.convertToPixel(
          [{ dataIndex: p.dataIndex, value: 0 }], { paneId: 'candle_pane' });
        if (Array.isArray(back) && back[0] && Number.isFinite(back[0].x)) {
          snapX = back[0].x;
        }
      }
    } catch (err) { /* fall back to raw x */ }
    _updatePickOverlay(snapX);
  };
  document.addEventListener('mousemove', _pickMouseMoveHandler);

  // Right-click anywhere on the chart → cancel picking.
  // Must use capture phase — drawing.js's own contextmenu listener on
  // #chart (child of #chart-area) also runs in capture and stopPropagation()s,
  // so a bubble-phase listener here never fires.
  _pickContextHandler = (e) => {
    if (!Replay.picking) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    _cancelPick();
  };
  area.addEventListener('contextmenu', _pickContextHandler, true);
}

function chartClick(e) {
  if (!Replay.picking || !Replay.chart) return;
  // Stop the click from propagating to KLineChart's internal handlers
  e.stopPropagation();
  e.preventDefault();

  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const dataIndex = _xyToDataIndex(Replay.chart, x, y, rect.width);
  _commitPick(dataIndex);
}

/** Mirror chartClick for the mini chart so picks made on the sub-pane
 *  also commit a cursor. Without this the user can see the dim
 *  follow on the mini but clicks there go nowhere — surprising,
 *  since the two charts otherwise behave like one synchronized
 *  surface. Uses MiniChart's own convertFromPixel against its local
 *  rect, then routes through the same `_commitPick` finalizer as the
 *  main click path. */
function miniChartClick(e) {
  if (!Replay.picking) return;
  const Mini = window.MiniChart;
  if (!Mini || !Mini.chart) return;
  e.stopPropagation();
  e.preventDefault();

  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const dataIndex = _xyToDataIndex(Mini.chart, x, y, rect.width);
  _commitPick(dataIndex);
}

/** Shared (chart, x, y) → dataIndex resolver used by both chartClick
 *  and miniChartClick. Tries known pane IDs first, then falls back
 *  to ratio-against-visibleRange, then last-resort full-length
 *  ratio. */
function _xyToDataIndex(chart, x, y, width) {
  for (const paneId of ['candle_pane', 'pane_candle', undefined]) {
    try {
      const opts = paneId ? { paneId } : {};
      const out = chart.convertFromPixel({ x, y }, opts);
      const pt = Array.isArray(out) ? out[0] : out;
      if (pt && Number.isFinite(pt.dataIndex)) return pt.dataIndex;
    } catch (err) { /* keep trying */ }
  }
  if (chart.getVisibleRange) {
    try {
      const vr = chart.getVisibleRange();
      if (vr && Number.isFinite(vr.from) && Number.isFinite(vr.to)) {
        const ratio = Math.max(0, Math.min(1, x / width));
        return Math.round(vr.from + ratio * (vr.to - vr.from));
      }
    } catch (err) { /* fall through */ }
  }
  const ratio = Math.max(0, Math.min(1, x / width));
  return Math.round(ratio * (Replay.baseBars.length - 1));
}

/** Final stage of a pick: tear down picking UI, clamp the chosen
 *  dataIndex against backward-only re-pick rules, and commit the
 *  cursor. Shared by main + mini click paths. */
function _commitPick(dataIndex) {
  Replay.picking = false;
  _removePickOverlays();
  _restorePickCrosshair();
  document.getElementById('rep-pick').classList.remove('active');

  // Re-picking can only go backward. If a cursor already exists, cap
  // the click at the current cursor bar so user can't select a
  // future slot.
  let safeIdx = Math.max(1, Math.min(Replay.baseBars.length - 1, dataIndex));
  if (Number.isFinite(Replay.cursorBarIdx) && Replay.cursorBarIdx > 0) {
    safeIdx = Math.min(safeIdx, Replay.cursorBarIdx);
  }
  setCursorAtBarIdx(safeIdx);
}

// ---- Init ----
function init(chart) {
  Replay.chart = chart;

  document.getElementById('btn-replay').addEventListener('click', () => {
    if (Replay.active) exitReplay();
    else enterReplay();
  });

  document.getElementById('rep-pick').addEventListener('click', enterPickMode);
  document.getElementById('rep-play').addEventListener('click', togglePlay);
  document.getElementById('rep-step-back').addEventListener('click', stepBack);
  document.getElementById('rep-step').addEventListener('click', async () => {
    await ensureSubBarsReady();
    tick();
  });
  document.getElementById('rep-end').addEventListener('click', jumpToEnd);
  document.getElementById('rep-exit').addEventListener('click', exitReplay);

  document.getElementById('rep-speed').addEventListener('change', (e) => {
    Replay.speed = parseFloat(e.target.value);
    if (Replay.playing) { pause(); play(); }
  });

  document.getElementById('rep-subtf').addEventListener('change', async (e) => {
    if (!Replay.active) return;
    Replay.subTf = e.target.value;
    Replay.subTfMs = parseTfMs(Replay.subTf);
    pause();
    // Re-fetch sub-bars using new sub-TF but KEEP cursorTimestamp + inProgressBar
    // (partial bar stays as-is, ticks will aggregate into it).
    await refreshSubBars();
  });

  // Click to pick
  document.getElementById('chart').addEventListener('click', chartClick, true);
  // Mirror click handler on the mini chart so picks made there also
  // commit. Capture phase + early `Replay.picking` check means
  // klinecharts' own click handlers still see the event when not in
  // picking mode (mini stays interactive for pan/zoom).
  const miniHost = document.getElementById('mini-chart');
  if (miniHost) {
    miniHost.addEventListener('click', miniChartClick, true);
  }

  // Hotkeys
  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement || {}).tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // Replay toggle is now Shift+R — plain 'r' is captured by app.js's
    // symbol-search letter trigger, so we'd double-fire (open replay
    // AND open symbol search) without the modifier.
    if (e.shiftKey && (e.key === 'R' || e.code === 'KeyR')) {
      if (Replay.active) exitReplay();
      else enterReplay();
      e.preventDefault();
    }
    if (e.key === ' ' && Replay.active) {
      togglePlay();
      e.preventDefault();
    }
    // TradingView-style replay step shortcuts (no modifier needed):
    //   . (period)  → step forward one sub-bar
    //   , (comma)   → step back one sub-bar
    // Arrow keys are left to KLineChart for panning.
    if (Replay.active && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key === '.' || e.key === '>' || e.code === 'Period') {
        (async () => { await ensureSubBarsReady(); tick(); })();
        e.preventDefault();
      } else if (e.key === ',' || e.key === '<' || e.code === 'Comma') {
        stepBack();
        e.preventDefault();
      }
    }
  });

  // Make replay bar draggable — start drag on any mousedown that's not on
  // a button / select (so clicks on controls still work as clicks).
  makeReplayBarDraggable();
}

function makeReplayBarDraggable() {
  const bar = document.getElementById('replay-bar');
  if (!bar) return;
  let dragging = false, startX, startY, startLeft, startTop;
  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, select, input')) return;   // leave controls alone
    const rect = bar.getBoundingClientRect();
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    // Pin via left/top, kill the centering transform
    bar.style.left = startLeft + 'px';
    bar.style.top  = startTop + 'px';
    bar.style.bottom = 'auto';
    bar.style.transform = 'none';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    bar.style.left = (startLeft + e.clientX - startX) + 'px';
    bar.style.top  = (startTop  + e.clientY - startY) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (dragging) document.body.style.userSelect = '';
    dragging = false;
  });
}

Replay.init = init;
Replay.parseTfMs = parseTfMs;
Replay.onTFChanged = onTFChanged;
Replay.tick = tick;
Replay.stepBack = stepBack;
// Exposed so app.js can orchestrate symbol switches cleanly:
Replay.saveReplayState = saveReplayState;
Replay.loadReplayState = loadReplayState;
Replay.clearReplayState = clearReplayState;
Replay._doExitReplay = _doExitReplay;
// Silent restore path — skips the continue/restart dialog. Used when the
// user switches to a symbol that already has a saved replay.
Replay.enterReplayRestore = async function (saved) {
  const App = window.App;
  if (!App || !App.currentBars.length) return;
  Replay.baseBars = App.currentBars.slice();
  Replay.displayBars = Replay.baseBars.slice();
  Replay.subBars = [];
  Replay.cursorIdx = 0;
  Replay.cursorTimestamp = null;
  Replay.maxCursorTs = null;       // §3.2.3 — restore path will re-bump via setCursorAtTimestamp below
  Replay.inProgressBar = null;
  Replay.tickHistory = [];
  Replay.displayTfMs = parseTfMs(App.currentTF);
  syncSubTfOptions(App.currentTF);
  if (saved && saved.subTf) {
    const sel = document.getElementById('rep-subtf');
    if (sel && [...sel.options].some(o => o.value === saved.subTf)) sel.value = saved.subTf;
  }
  Replay.subTf = document.getElementById('rep-subtf').value;
  Replay.subTfMs = parseTfMs(Replay.subTf);
  Replay.active = true;
  document.getElementById('replay-bar').classList.remove('hidden');
  document.getElementById('btn-replay').classList.add('active');
  if (saved && saved.cursorTimestamp) {
    await setCursorAtTimestamp(saved.cursorTimestamp);
  }
  updateStatus();
};
