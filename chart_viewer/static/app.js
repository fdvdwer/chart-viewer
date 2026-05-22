/**
 * app.js — main chart viewer app
 *
 * Responsibilities:
 *   - Init KLineChart with candle + volume sub-pane
 *   - Fetch OHLCV from /api/ohlcv
 *   - Number-key timeframe switching (1, 5, 15 default min; 1d/1h/5m suffix)
 *   - Expose chart + state to drawing.js / replay.js via window.App
 */
/* global klinecharts */

const App = {
  chart: null,
  currentTF: '15',          // no suffix = minutes (TradingView convention)
  currentSymbol: null,      // e.g. 'NQ1' — set after /api/symbols returns
  symbols: [],              // all loaded symbols
  currentBars: [],
  currentLayoutId: null,    // active layout — null means home view is showing
  openTabs: [],             // array of layoutIds currently shown as tabs
  layoutsMeta: [],           // cached list of all layouts (for tab labels)
  // Pagination state for lazy loading (KLineChart loadMore callback)
  loadingMore: false,
  noMoreData: false,
};

const INITIAL_BARS = 2000;   // first fetch per TF
const PAGE_BARS = 2000;      // each loadMore page

window.App = App;

// ----- Timezone display: data is UTC, display in ET -----
const DISPLAY_TZ = 'America/New_York';

// ----- KLineChart locale + tooltip helpers -----
// KLineChart 9 ships only zh-CN and en-US built-in. We map our I18n
// lang → the closest built-in (zh-TW is silently dropped to zh-CN
// upstream, hence the explicit zh-CN here). The candle tooltip OHLCV
// labels are rendered from OUR dictionary (chart.tooltip*) — the lib's
// built-in locale only governs labels we don't override (e.g. axis).
function _klineLocale() {
  return (window.I18n && window.I18n.lang === 'en') ? 'en-US' : 'zh-CN';
}
function _ohlcTooltipCustom() {
  const t = (k) => (window.I18n ? window.I18n.t(k) : k);
  return [
    { title: t('chart.tooltipOpen'),   value: '{open}' },
    { title: t('chart.tooltipHigh'),   value: '{high}' },
    { title: t('chart.tooltipLow'),    value: '{low}' },
    { title: t('chart.tooltipClose'),  value: '{close}' },
    { title: t('chart.tooltipVolume'), value: '{volume}' },
  ];
}

// ----- Init -----
function initChart() {
  const chart = klinecharts.init('chart', {
    locale: _klineLocale(),
    timezone: DISPLAY_TZ,
    styles: {
      grid: {
        horizontal: { color: 'rgba(42,46,57,0.5)' },
        vertical: { color: 'rgba(42,46,57,0.5)' },
      },
      candle: {
        bar: {
          upColor: '#26a69a', downColor: '#ef5350',
          upBorderColor: '#26a69a', downBorderColor: '#ef5350',
          upWickColor: '#26a69a', downWickColor: '#ef5350',
        },
        tooltip: {
          showRule: 'always',
          showType: 'standard',
          custom: _ohlcTooltipCustom(),
        },
        priceMark: {
          last: {
            show: true,
            line: { show: true, style: 'dashed' },
          },
        },
      },
      crosshair: {
        horizontal: { line: { color: '#888', style: 'dashed' } },
        vertical: { line: { color: '#888', style: 'dashed' } },
      },
      xAxis: { axisLine: { color: '#363a45' }, tickText: { color: '#787b86' } },
      yAxis: { axisLine: { color: '#363a45' }, tickText: { color: '#787b86' } },
      indicator: {
        bars: [{
          upColor: 'rgba(38,166,154,0.5)',
          downColor: 'rgba(239,83,80,0.5)',
          noChangeColor: '#888',
        }],
      },
      // Hide the inter-pane separator so the volume sub-pane below
      // visually merges with the candle pane (TradingView-style
      // bottom-stacked layout) while keeping its own y-axis scale.
      separator: { size: 0, color: 'transparent', activeBackgroundColor: 'transparent' },
    },
  });

  // Volume in its OWN pane (separate y-axis so volume bars aren't
  // squeezed by the price range), but visually flush with the candle
  // pane via the transparent separator above + a shallow height.
  // `calcParams: []` disables the default VOL MA lines (5/10/20).
  chart.createIndicator(
    { name: 'VOL', calcParams: [] },
    false,
    { id: 'pane_vol', height: 90, dragEnabled: false }
  );

  App.chart = chart;

  // Spec i18n §4.3: flip KLineChart's built-in locale (axis tooltip,
  // crosshair time format) AND our custom OHLCV tooltip labels when
  // the user toggles language. Idempotent guard avoids stacking on
  // hot-reload / re-init.
  if (!App._chartI18nWired) {
    App._chartI18nWired = true;
    document.addEventListener('i18n:change', () => {
      if (!App.chart) return;
      try { App.chart.setLocale(_klineLocale()); } catch (e) {}
      try {
        App.chart.setStyles({
          candle: { tooltip: { custom: _ohlcTooltipCustom() } },
        });
      } catch (e) {}
    });
  }

  return chart;
}

// ----- Fetch OHLCV -----
// opts: { start, end, before (ms), limit }
async function fetchOHLCV(tf, opts = {}) {
  const params = new URLSearchParams({ tf });
  const symbol = opts.symbol || App.currentSymbol;
  if (symbol) params.set('symbol', symbol);
  if (opts.start) params.set('start', opts.start);
  if (opts.end) params.set('end', opts.end);
  if (opts.before) params.set('before', String(opts.before));
  if (opts.limit) params.set('limit', String(opts.limit));
  const r = await fetch(`/api/ohlcv?${params}`);
  if (!r.ok) throw new Error(`fetch /api/ohlcv failed: ${r.status}`);
  return r.json();
}

function formatTfDisplay(tf) {
  // "15" → "15", "1h" → "1H", "1m" → "1M"
  const m = tf.match(/^(\d+)([a-z]*)$/i);
  if (!m) return tf;
  return m[1] + (m[2] ? m[2].toUpperCase() : '');
}

async function loadTimeframe(tf) {
  if (!App.chart) return;
  document.getElementById('tf-display').textContent = formatTfDisplay(tf);
  App.currentTF = tf;
  App.noMoreData = false;
  App.loadingMore = false;
  // Remember TF in the active layout's state.
  if (typeof schedulePersistLayoutState === 'function') schedulePersistLayoutState();
  try {
    let bars = await fetchOHLCV(tf, { limit: INITIAL_BARS });

    // If replay is active and cursor falls before the loaded range, keep
    // fetching older pages until cursor is covered (or safety cap reached).
    const cursorTS = (window.Replay && window.Replay.active)
      ? window.Replay.cursorTimestamp : null;
    if (cursorTS && bars.length && bars[0].timestamp > cursorTS) {
      for (let i = 0; i < 10; i++) {
        const older = await fetchOHLCV(tf, {
          before: bars[0].timestamp, limit: INITIAL_BARS,
        });
        if (!older.length) break;
        bars = older.concat(bars);
        if (bars[0].timestamp <= cursorTS) break;
      }
    }

    App.currentBars = bars;
    if (window.Replay && window.Replay.active && window.Replay.onTFChanged) {
      await window.Replay.onTFChanged();
    } else {
      App.chart.applyNewData(bars, bars.length >= INITIAL_BARS);
    }
    if (window.MiniChart && window.MiniChart.refreshData) {
      window.MiniChart.refreshData();
    }
    // Sim panel reads bid/ask from the latest bar — refresh it whenever
    // we swap the bar set so the panel doesn't display stale prices.
    if (window.SimPanel && window.SimPanel.refresh) window.SimPanel.refresh();
    if (window.SimOverlays && window.SimOverlays.sync) window.SimOverlays.sync();
  } catch (e) {
    console.error(e);
  }
}

// Register lazy-load callback once — fetches older page when user pans left
// past the earliest loaded bar.
function initPagination() {
  if (!App.chart || typeof App.chart.loadMore !== 'function') return;
  App.chart.loadMore(async (earliestTs) => {
    if (App.loadingMore || App.noMoreData) return;
    App.loadingMore = true;
    try {
      const older = await fetchOHLCV(App.currentTF, {
        before: earliestTs,
        limit: PAGE_BARS,
      });
      if (older.length === 0) {
        App.noMoreData = true;
        App.chart.applyNewData(App.currentBars, false);
        return;
      }
      App.currentBars = older.concat(App.currentBars);
      App.chart.applyNewData(App.currentBars, older.length >= PAGE_BARS);
    } catch (e) {
      console.error('[loadMore]', e);
    } finally {
      App.loadingMore = false;
    }
  });
}

// ----- Data range display -----
async function loadRange() {
  try {
    const params = new URLSearchParams();
    if (App.currentSymbol) params.set('symbol', App.currentSymbol);
    const r = await fetch(`/api/range?${params}`);
    const j = await r.json();
    if (j.start && j.end) {
      const fmt = (s) => s.split('T')[0];
      document.getElementById('data-range').textContent =
        `${fmt(j.start)} ~ ${fmt(j.end)}  ·  ${j.count.toLocaleString()} bars`;
    }
  } catch (e) { /* ignore */ }
}

// ----- Fetch + cache available symbols -----
async function loadSymbols() {
  try {
    const r = await fetch('/api/symbols');
    const j = await r.json();
    App.symbols = Array.isArray(j.symbols) ? j.symbols : [];
  } catch (e) {
    console.error('[symbols]', e);
    App.symbols = [];
  }
}

// ----- Switch symbol: load new OHLCV, refresh ranges, remap overlays -----
async function switchSymbol(symbol) {
  if (!symbol || symbol === App.currentSymbol) return;
  if (!App.symbols.includes(symbol)) {
    console.warn('[switchSymbol] unknown symbol', symbol);
    return;
  }
  const oldSymbol = App.currentSymbol;

  // Replay state is a singleton, so switching symbols without cleanup leaks
  // the source symbol's data (bars, cursor, placeholder prices) into the
  // target. Snapshot the live session under the OLD symbol's key so the user
  // can resume later, then tear it down.
  const R = window.Replay;
  if (R && R.active && R.cursorTimestamp != null
      && R.saveReplayState && oldSymbol) {
    R.saveReplayState(oldSymbol, {
      cursorTimestamp: R.cursorTimestamp,
      tf: App.currentTF,
      subTf: R.subTf,
      savedAt: Date.now(),
    });
  }
  if (R && R.active && R._doExitReplay) {
    R._doExitReplay();                       // silent teardown (no dialog)
  }

  App.currentSymbol = symbol;
  try { localStorage.setItem('chart_viewer_current_symbol', symbol); } catch (e) {}
  // Remember active symbol in the current layout's state so re-opening the
  // app lands on the right instrument.
  if (typeof schedulePersistLayoutState === 'function') schedulePersistLayoutState();
  const label = document.querySelector('#topbar .symbol');
  if (label) label.textContent = symbol + '!';

  // Reload chart with the new symbol's data at the current TF.
  await loadRange();
  await loadTimeframe(App.currentTF);

  // Drawing side: save under old symbol, clear, load new symbol's drawings.
  if (window.Drawing && window.Drawing.onSymbolChanged) {
    window.Drawing.onSymbolChanged(oldSymbol, symbol);
  } else if (window.Drawing && window.Drawing.reanchorOverlaysWithDataIndex) {
    window.Drawing.reanchorOverlaysWithDataIndex(App.currentBars);
  }

  // Sim engine: flush old symbol's state, recreate engine with new
  // symbol's spec, fetch saved state for the new symbol.
  if (window.SimController && window.SimController.onSymbolChanged) {
    await window.SimController.onSymbolChanged(symbol);
  }

  // Symbol switch intentionally does NOT auto-enter replay. Even if the new
  // symbol has a saved replay, the user should see its latest bars as a
  // clean slate. They'll hit the 重播 button manually, which will show the
  // continue/restart dialog with the saved entry.
}

// ----- TradingView-style timeframe input popup -----
//   Plain digits → minutes (no suffix). e.g. "15" = 15 分鐘
//   m/h/d/w suffix (uppercase in popup):
//     m = month (月), h = hour (小時), d = day (日), w = week (週)
//   Enter → commit, Esc → cancel, Backspace → delete last char
//   Click outside popup → cancel. No auto-commit.
// Spec i18n §3.9 — TF unit labels routed through dictionary so the
// "15 分鐘" / "15 Minute" preview line in the TF popup flips with
// language. Keys are looked up at render time, not at module-init.
const TF_UNIT_KEYS = {
  m: 'dlg.tfMonth',
  h: 'dlg.tfHour',
  d: 'dlg.tfDay',
  w: 'dlg.tfWeek',
};
const NO_SUFFIX_KEY = 'dlg.tfMinute';

const TfInput = {
  buffer: '',                 // raw text e.g. "15h"
};

function isFormFocused() {
  const el = document.activeElement;
  if (!el) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function tfPopupShow() {
  document.getElementById('tf-popup').classList.remove('hidden');
}
function tfPopupHide() {
  document.getElementById('tf-popup').classList.add('hidden');
  document.getElementById('tf-popup').classList.remove('invalid');
  TfInput.buffer = '';
}
function tfPopupRender() {
  const buf = TfInput.buffer;
  const popup = document.getElementById('tf-popup');
  const m = buf.match(/^(\d+)([mhdw]?)$/i);
  let displayText = '', subText = '', invalid = false;
  const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
  const naLabel = t_('dlg.tfNotApplicable');
  if (!buf) {
    displayText = '';
    subText = naLabel;
    invalid = true;
  } else if (m) {
    const n = m[1];
    const unit = (m[2] || '').toLowerCase();
    displayText = n + (unit ? unit.toUpperCase() : '');
    const label = t_(unit ? TF_UNIT_KEYS[unit] : NO_SUFFIX_KEY);
    subText = `${n} ${label}`;
  } else {
    displayText = buf.toUpperCase();
    subText = naLabel;
    invalid = true;
  }
  popup.classList.toggle('invalid', invalid);
  document.getElementById('tf-popup-input').textContent = displayText;
  document.getElementById('tf-popup-sub').textContent = subText;
}
function tfCommit() {
  const m = TfInput.buffer.match(/^(\d+)([mhdw]?)$/i);
  if (m) {
    // Pass buffer as-is: "15" stays "15" (minutes), "15m" stays "15m" (month)
    const tf = (m[1] + (m[2] || '').toLowerCase());
    loadTimeframe(tf);
    tfPopupHide();
  }
}

// Click outside popup → close (without committing)
document.addEventListener('mousedown', (e) => {
  const pop = document.getElementById('tf-popup');
  if (!pop || pop.classList.contains('hidden')) return;
  if (pop.contains(e.target)) return;
  tfPopupHide();
}, true);

function isTfPopupOpen() {
  return !document.getElementById('tf-popup').classList.contains('hidden');
}

// Extract digit/unit from event — falls back to physical e.code when IME
// rewrites e.key to "Process" / unidentified chars.
function getDigitFromEvent(e) {
  if (/^[0-9]$/.test(e.key)) return e.key;
  const m = /^Digit([0-9])$/.exec(e.code || '');
  return m ? m[1] : null;
}
function getUnitFromEvent(e) {
  const lower = (e.key || '').toLowerCase();
  if (TF_UNITS[lower]) return lower;
  const m = /^Key([MHDW])$/.exec(e.code || '');
  return m ? m[1].toLowerCase() : null;
}
function isControlKey(e, name) {
  if (e.key === name) return true;
  if (e.code === name) return true;
  return false;
}

document.addEventListener('keydown', (e) => {
  if (isFormFocused()) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.isComposing) return;             // IME composing — ignore

  // Digit → open TF popup
  const digit = getDigitFromEvent(e);
  if (digit !== null) {
    TfInput.buffer += digit;
    tfPopupShow();
    tfPopupRender();
    e.preventDefault();
    return;
  }

  // Alpha char (not already in another popup) → open Symbol search.
  // TF popup is reserved for digits + unit-suffix editing, so letters only
  // trigger symbol search when no popup is open. Skip on Shift so combos
  // like Shift+R (replay toggle) don't double-fire — those still pass
  // through to module-specific keydown handlers.
  if (!isTfPopupOpen() && !SymSearch.isOpen() && !e.shiftKey) {
    const letter = (e.key || '').match(/^[A-Za-z]$/);
    if (letter) {
      SymSearch.open(letter[0]);
      e.preventDefault();
      return;
    }
  }

  if (!isTfPopupOpen()) return;

  // Unit suffix
  const unit = getUnitFromEvent(e);
  if (unit) {
    TfInput.buffer = TfInput.buffer.replace(/[mhdw]$/i, '') + unit;
    tfPopupRender();
    e.preventDefault();
    return;
  }
  if (isControlKey(e, 'Enter')) {
    tfCommit();
    e.preventDefault();
    return;
  }
  if (isControlKey(e, 'Escape')) {
    tfPopupHide();
    e.preventDefault();
    return;
  }
  if (isControlKey(e, 'Backspace')) {
    TfInput.buffer = TfInput.buffer.slice(0, -1);
    tfPopupRender();
    e.preventDefault();
    return;
  }
});

// ----- Symbol search dialog -----
const SymSearch = {
  modal: null,
  input: null,
  list: null,
  activeIdx: 0,
  filtered: [],

  init() {
    this.modal = document.getElementById('symbol-search');
    this.input = document.getElementById('sym-input');
    this.list  = document.getElementById('sym-list');
    if (!this.modal) return;
    // Close via X / backdrop / Esc
    document.getElementById('sym-close').addEventListener('click', () => this.close());
    const rescanBtn = document.getElementById('sym-rescan');
    if (rescanBtn) {
      rescanBtn.addEventListener('click', async () => {
        rescanBtn.disabled = true;
        try { await rescanDataDir(); }
        finally { rescanBtn.disabled = false; }
      });
    }
    this.modal.querySelector('.symbol-backdrop')
      .addEventListener('click', () => this.close());
    this.input.addEventListener('input', () => this.render());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { this.move(+1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { this.move(-1); e.preventDefault(); }
      else if (e.key === 'Enter') { this.commit(); e.preventDefault(); }
      else if (e.key === 'Escape') { this.close(); e.preventDefault(); }
    });
    // Header symbol label is click-to-open.
    const label = document.querySelector('#topbar .symbol');
    if (label) {
      label.classList.add('clickable');
      label.addEventListener('click', () => this.open());
    }
  },

  isOpen() {
    return this.modal && !this.modal.classList.contains('hidden');
  },

  open(prefill = '') {
    if (!this.modal) return;
    this.input.value = prefill;
    this.modal.classList.remove('hidden');
    this.render();
    // Focus at end so user can keep typing.
    setTimeout(() => {
      this.input.focus();
      const n = this.input.value.length;
      this.input.setSelectionRange(n, n);
    }, 0);
  },

  close() {
    if (this.modal) this.modal.classList.add('hidden');
  },

  // Filter + render the list. Activates the first item.
  render() {
    const q = (this.input.value || '').trim().toLowerCase();
    const items = App.symbols.filter(s => !q || s.toLowerCase().includes(q));
    this.filtered = items;
    this.activeIdx = 0;
    this.list.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'sym-empty';
      const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
      empty.textContent = q ? t_('dlg.symSearchEmpty') : t_('dlg.symSearchEmptyAll');
      this.list.appendChild(empty);
      return;
    }
    items.forEach((sym, i) => {
      const row = document.createElement('div');
      row.className = 'sym-item' + (i === 0 ? ' active' : '');
      row.dataset.symbol = sym;
      row.innerHTML = `
        <span class="sym-code">${sym}</span>
        <span class="sym-desc">${symbolDescription(sym)}</span>
        <span class="sym-source">${symbolExchange(sym)}</span>
      `;
      row.addEventListener('mouseenter', () => this.setActive(i));
      row.addEventListener('click', () => { this.setActive(i); this.commit(); });
      this.list.appendChild(row);
    });
  },

  setActive(i) {
    this.activeIdx = Math.max(0, Math.min(this.filtered.length - 1, i));
    [...this.list.querySelectorAll('.sym-item')].forEach((el, idx) => {
      el.classList.toggle('active', idx === this.activeIdx);
    });
  },

  move(delta) {
    this.setActive(this.activeIdx + delta);
    const active = this.list.querySelector('.sym-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  },

  async commit() {
    const sym = (this.filtered[this.activeIdx] || '').toUpperCase();
    if (!sym) return;
    this.close();
    await switchSymbol(sym);
  },
};

// Human-readable tags. Primary source is the SymbolSpecs dictionary —
// every symbol the user has set up in Settings → Symbol Specs already
// carries a displayName + currency there, so we read it first and only
// fall back to the legacy hardcoded map for codes nobody has specced
// (e.g. YM1 / RTY1, which still appear in some users' market_data/).
function symbolDescription(sym) {
  if (window.SymbolSpecs && window.SymbolSpecs.isKnownSymbol(sym)) {
    const spec = window.SymbolSpecs.getSpec(sym);
    if (spec && spec.displayName) return spec.displayName;
  }
  const map = {
    NQ1: 'E-mini Nasdaq-100 Futures',
    TXF1: '臺指期貨（大臺）',
    MXF1: '小型臺指期',
    ES1: 'E-mini S&P 500 Futures',
    YM1: 'E-mini Dow Futures',
    RTY1: 'E-mini Russell 2000 Futures',
    CL1: 'WTI Crude Oil Futures',
    GC1: 'Gold Futures',
  };
  return map[sym] || '';
}
function symbolExchange(sym) {
  if (/^TXF|MXF|TE|TF/.test(sym)) return 'TAIFEX';
  // EC = 6E Euro FX (CME), MNQ/MES/MGC are micros (CME), GC/MGC = COMEX
  // (CME Group). Spot symbols like XAUUSD have no exchange — they trade
  // OTC against a broker, so leave the column blank.
  if (/^(NQ|MNQ|ES|MES|YM|RTY|CL|GC|MGC|EC)/.test(sym)) return 'CME';
  return '';
}

// ----- Layouts: home view + routing ---------------------------------
// A Layout is a sandbox of { currentSymbol, currentTF, drawings-per-symbol,
// replay-per-symbol }. The user can have many. On boot we fetch the list
// from /api/layouts and open the last-used one; if none exist, the server
// auto-creates a default.

// Translate the auto-default layout name based on current I18n.lang.
// Mirrors the branch.kindMain pattern (i18n-spec §4.4) — only the
// canonical pair "預設版面" / "Default Layout" gets translated. User-
// renamed layouts are user data and stay verbatim. Used at every
// layout-name render site (TabBar, Layouts home cards, dialogs).
function displayLayoutName(name) {
  if (!name) return '';
  if (name === '預設版面' || name === 'Default Layout') {
    return (window.I18n && window.I18n.t)
      ? window.I18n.t('app.defaultLayoutName') : name;
  }
  return name;
}

const Layouts = {
  home: null,
  grid: null,
  dialog: null,

  init() {
    this.home = document.getElementById('layouts-home');
    this.grid = document.getElementById('lh-grid');
    this.dialog = document.getElementById('layout-name-dialog');

    // Spec i18n §4.3: re-render layout cards on language change so
    // "未命名" / "Untitled", "建立新版面" / "New Layout", and the
    // fmtDate month abbreviation flip for any visible card.
    if (!Layouts._i18nWired) {
      Layouts._i18nWired = true;
      document.addEventListener('i18n:change', () => {
        if (this.home && !this.home.classList.contains('hidden')) {
          try { this.render(); } catch (e) {}
        }
      });
    }

    document.getElementById('lh-new-btn').addEventListener('click', () => this.createPrompt());
    document.getElementById('btn-layouts').addEventListener('click', () => this.show());

    // Name dialog wiring
    const input = document.getElementById('lnd-input');
    const btnConfirm = document.getElementById('lnd-confirm');
    const btnCancel = document.getElementById('lnd-cancel');
    const btnClose = document.getElementById('lnd-close');
    const backdrop = this.dialog.querySelector('.lnd-backdrop');
    input.addEventListener('input', () => {
      btnConfirm.disabled = !input.value.trim();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !btnConfirm.disabled) { e.preventDefault(); btnConfirm.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.closeDialog(); }
    });
    btnCancel.addEventListener('click', () => this.closeDialog());
    btnClose.addEventListener('click', () => this.closeDialog());
    backdrop.addEventListener('click', () => this.closeDialog());
    btnConfirm.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) return;
      const renameId = this._renameTarget;
      this.closeDialog();
      if (renameId) {
        // Rename flow: PATCH + re-render home (if visible) or update header label.
        await this.apiPatch(renameId, { name });
        if (!this.home.classList.contains('hidden')) await this.render();
      } else {
        // Create flow: POST + open new layout.
        const layout = await this.apiCreate(name);
        if (layout) await openLayout(layout.id);
      }
    });
  },

  async show() {
    this.home.classList.remove('hidden');
    await this.render();
  },

  hide() { this.home.classList.add('hidden'); },

  async render() {
    const data = await this.apiList();
    const layouts = (data && data.layouts) || [];
    App.layoutsMeta = layouts;
    // Prune openTabs in case something got deleted out from under us.
    const validIds = new Set(layouts.map(l => l.id));
    App.openTabs = App.openTabs.filter(id => validIds.has(id));
    if (typeof TabBar !== 'undefined') TabBar.render();
    // Rebuild grid preserving the "create new" card at front.
    this.grid.innerHTML = '';
    const t_ = (k, vars) => (window.I18n && window.I18n.t) ? window.I18n.t(k, vars) : k;
    const newBtn = document.createElement('button');
    newBtn.className = 'lh-card lh-new';
    newBtn.id = 'lh-new-btn';
    newBtn.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      <span>${escapeHTML(t_('dlg.layoutNewTitle'))}</span>`;
    newBtn.addEventListener('click', () => this.createPrompt());
    this.grid.appendChild(newBtn);

    const favTitle  = t_('dlg.layoutFav');
    const moreTitle = t_('dlg.layoutMore');
    const untitled  = t_('dlg.layoutUnnamed');
    for (const L of layouts) {
      const card = document.createElement('div');
      card.className = 'lh-card';
      const sub = (L.lastSymbol ? `${L.lastSymbol}!` : '') +
                  (L.lastTF ? `, ${formatTfDisplay(L.lastTF)}` : '') +
                  (L.updatedAt ? ` · ${fmtDate(L.updatedAt)}` : '');
      card.innerHTML = `
        <button class="lh-fav" title="${escapeHTML(favTitle)}">☆</button>
        <button class="lh-menu" title="${escapeHTML(moreTitle)}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="1.6"/>
            <circle cx="12" cy="12" r="1.6"/>
            <circle cx="12" cy="19" r="1.6"/>
          </svg>
        </button>
        <div class="lh-name">${escapeHTML(displayLayoutName(L.name) || untitled)}</div>
        <div class="lh-sub">${escapeHTML(sub)}</div>`;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.lh-menu') || e.target.closest('.lh-fav')) return;
        openLayout(L.id);
      });
      card.querySelector('.lh-menu').addEventListener('click', (e) => {
        e.stopPropagation();
        this.showCardMenu(e.currentTarget, L);
      });
      this.grid.appendChild(card);
    }
  },

  // Small menu anchored under the clicked ⋮ button.
  showCardMenu(anchorEl, layout) {
    this.hideCardMenu();
    const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
    const menu = document.createElement('div');
    menu.className = 'lh-menu-pop';
    menu.innerHTML = `
      <div class="lh-menu-item" data-act="rename">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
        <span>${escapeHTML(t_('dlg.layoutMenuRename'))}</span>
      </div>
      <div class="lh-menu-item lh-menu-danger" data-act="delete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
        <span>${escapeHTML(t_('dlg.layoutMenuDelete'))}</span>
      </div>`;
    document.body.appendChild(menu);
    this._menuEl = menu;
    this._menuLayout = layout;
    // Position under the button.
    const r = anchorEl.getBoundingClientRect();
    const w = menu.offsetWidth;
    let left = r.right - w;
    if (left < 8) left = 8;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    menu.style.left = left + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
    menu.addEventListener('click', (e) => {
      const act = e.target.closest('.lh-menu-item');
      if (!act) return;
      this.hideCardMenu();
      if (act.dataset.act === 'rename') this.renamePrompt(layout);
      else if (act.dataset.act === 'delete') this.deletePrompt(layout);
    });
    // Dismiss on outside click
    setTimeout(() => {
      document.addEventListener('mousedown', this._menuDismiss, { once: true, capture: true });
    }, 0);
  },

  _menuDismiss(e) {
    const app = window.App && window.App.Layouts;
    if (!app || !app._menuEl) return;
    if (app._menuEl.contains(e.target)) return;
    app.hideCardMenu();
  },

  hideCardMenu() {
    if (this._menuEl) { this._menuEl.remove(); this._menuEl = null; }
    this._menuLayout = null;
  },

  async deletePrompt(layout) {
    const t_ = (k, vars) => (window.I18n && window.I18n.t) ? window.I18n.t(k, vars) : k;
    if (!confirm(t_('dlg.layoutDeleteConfirm', { name: displayLayoutName(layout.name) }))) return;
    await this.apiDelete(layout.id);
    await this.render();
  },

  // Reuse the name dialog — different title + button, calls PATCH instead of POST.
  renamePrompt(layout) {
    const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
    const input = document.getElementById('lnd-input');
    const title = document.getElementById('lnd-title');
    const confirm = document.getElementById('lnd-confirm');
    title.textContent = t_('dlg.layoutRenameTitle');
    confirm.textContent = t_('dlg.layoutRenameBtn');
    input.value = displayLayoutName(layout.name);
    confirm.disabled = !input.value.trim();
    this._renameTarget = layout.id;
    this.dialog.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 0);
  },

  createPrompt() {
    const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
    const input = document.getElementById('lnd-input');
    document.getElementById('lnd-title').textContent = t_('dlg.layoutNewTitle');
    document.getElementById('lnd-confirm').textContent = t_('dlg.layoutNewBtn');
    this._renameTarget = null;
    input.value = t_('dlg.layoutNewDefaultName');
    document.getElementById('lnd-confirm').disabled = false;
    this.dialog.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 0);
  },
  closeDialog() { this.dialog.classList.add('hidden'); this._renameTarget = null; },

  // API ------
  async apiList() {
    try {
      const r = await fetch('/api/layouts');
      return r.ok ? await r.json() : { layouts: [] };
    } catch (e) { return { layouts: [] }; }
  },
  async apiCreate(name) {
    try {
      const r = await fetch('/api/layouts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  },
  async apiDelete(id) {
    try { await fetch('/api/layouts/' + encodeURIComponent(id), { method: 'DELETE' }); }
    catch (e) {}
  },
  async apiGetState(id) {
    try {
      const r = await fetch(`/api/layouts/${encodeURIComponent(id)}/state`);
      return r.ok ? await r.json() : {};
    } catch (e) { return {}; }
  },
  async apiPutState(id, state) {
    try {
      await fetch(`/api/layouts/${encodeURIComponent(id)}/state`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
    } catch (e) {}
  },
  async apiPatch(id, patch) {
    try {
      await fetch('/api/layouts/' + encodeURIComponent(id), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch (e) {}
  },
};

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(ms) {
  // Spec i18n §4.5 — locale-aware via toLocaleString instead of a
  // hardcoded month-name array. en-US: "5 May '26"; zh-TW: "5 5月 '26".
  try {
    const d = new Date(ms);
    const lang = (window.I18n && window.I18n.lang) || 'zh';
    const localeTag = lang === 'en' ? 'en-US' : 'zh-TW';
    // 'narrow' for zh produces "5月"; 'short' for en produces "May".
    const monthFmt = lang === 'en' ? 'short' : 'narrow';
    const m = d.toLocaleString(localeTag, { month: monthFmt });
    const y = String(d.getFullYear()).slice(-2);
    return `${d.getDate()} ${m} '${y}`;
  } catch (e) { return ''; }
}

// Open a specific layout: load its state, switch symbol/TF, flip to chart view.
async function openLayout(layoutId) {
  if (!layoutId) return;
  // Flush the OUTGOING layout's branch + sim state to disk before we
  // swap context. Otherwise a debounced PUT in flight would write
  // against the new layout id and silently corrupt it.
  if (window.BranchEngine && window.BranchEngine.flushNow) {
    await window.BranchEngine.flushNow();
  }
  if (window.SimController && window.SimController.flushNow) {
    await window.SimController.flushNow();
  }
  App.currentLayoutId = layoutId;
  // Pre-set SimController layout id so any onSymbolChanged path
  // triggered by the switchSymbol call below persists against the
  // NEW layout, not the old one.
  if (window.SimController) window.SimController._layoutId = layoutId;
  // Load the new layout's branch session BEFORE switching symbols —
  // SimController.placeOrder reads BranchEngine.activeBranchId to
  // stamp orders, so this must be in place first.
  if (window.BranchEngine && window.BranchEngine.loadForLayout) {
    await window.BranchEngine.loadForLayout(layoutId);
  }
  // Ensure it appears in the tab bar.
  if (!App.openTabs.includes(layoutId)) App.openTabs.push(layoutId);
  if (typeof TabBar !== 'undefined') {
    await TabBar.refreshMeta();
    TabBar.render();
    TabBar.persist();
  }
  Layouts.hide();

  // Load the layout's last-known state.
  const state = await Layouts.apiGetState(layoutId);
  let wantSymbol = state.currentSymbol || App.symbols[0];
  // If the saved symbol isn't present in the current market_data/ folder
  // (e.g. user swapped data folders since last session), fall back to the
  // first available symbol instead of leaving the chart on a dead symbol.
  if (!App.symbols.includes(wantSymbol)) {
    console.warn(`[layout] saved symbol "${wantSymbol}" not in loaded set; falling back to "${App.symbols[0]}"`);
    wantSymbol = App.symbols[0];
  }
  const wantTF = state.currentTF || '15';

  // If symbol changed, switch (but we're coming from home view — skip the
  // "save old layout" ritual by setting currentSymbol directly first).
  if (!App.currentSymbol) App.currentSymbol = wantSymbol;
  if (App.currentSymbol !== wantSymbol) {
    await switchSymbol(wantSymbol);
  } else {
    // Same symbol — just re-load drawings for this layout.
    if (window.Drawing && window.Drawing.onLayoutChanged) {
      window.Drawing.onLayoutChanged(wantSymbol);
    }
  }
  App.currentTF = wantTF;
  const label = document.querySelector('#topbar .symbol');
  if (label) label.textContent = (App.currentSymbol || '') + '!';
  document.getElementById('tf-display').textContent = formatTfDisplay(wantTF);
  await loadRange();
  await loadTimeframe(wantTF);

  // Load sim engine state for the resolved (layout, symbol) pair.
  // switchSymbol may already have called loadForLayout via
  // onSymbolChanged when the symbol changed — this final call covers
  // the "same symbol as last layout" path AND is idempotent on the
  // server (just a fresh GET + restore).
  if (window.SimController && window.SimController.loadForLayout) {
    await window.SimController.loadForLayout(layoutId, App.currentSymbol);
  }

  // Mark this layout as last-used on the server.
  await Layouts.apiPatch(layoutId, { setLast: true });
}

// ----- Tab bar: browser-style open layouts ---------------------------
const TabBar = {
  scroll: null,
  addBtn: null,
  init() {
    this.scroll = document.getElementById('tabs-scroll');
    this.addBtn = document.getElementById('tab-add-btn');
    this.addBtn.addEventListener('click', () => Layouts.show());
    // Re-render tab labels on language change so the auto-default
    // layout name flips between "預設版面" and "Default Layout".
    // User-renamed tabs stay unchanged via displayLayoutName's
    // canonical-match guard. Idempotent guard avoids listener stacking.
    if (!TabBar._i18nWired) {
      TabBar._i18nWired = true;
      document.addEventListener('i18n:change', () => {
        try { this.render(); } catch (e) { /* ignore */ }
      });
    }
  },
  render() {
    if (!this.scroll) return;
    this.scroll.innerHTML = '';
    for (const id of App.openTabs) {
      const meta = App.layoutsMeta.find(l => l.id === id);
      if (!meta) continue;
      const tab = document.createElement('div');
      tab.className = 'tab' + (id === App.currentLayoutId ? ' active' : '');
      tab.dataset.id = id;
      const closeTitle = (window.I18n && window.I18n.t)
        ? window.I18n.t('topbar.tabClose') : '關閉';
      tab.innerHTML = `
        <span class="tab-label">${escapeHTML(displayLayoutName(meta.name))}</span>
        <button class="tab-close" title="${escapeHTML(closeTitle)}">×</button>
      `;
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.tab-close')) return;
        if (id !== App.currentLayoutId) openLayout(id);
      });
      tab.querySelector('.tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(id);
      });
      this.scroll.appendChild(tab);
    }
  },
  async openTab(layoutId) {
    if (!App.openTabs.includes(layoutId)) {
      App.openTabs.push(layoutId);
      await this.persist();
    }
    this.render();
  },
  async closeTab(layoutId) {
    const idx = App.openTabs.indexOf(layoutId);
    if (idx < 0) return;
    App.openTabs.splice(idx, 1);
    if (layoutId === App.currentLayoutId) {
      // Promote the neighbor (or go to home if none remain).
      const next = App.openTabs[idx] || App.openTabs[idx - 1] || null;
      if (next) {
        await openLayout(next);
      } else {
        App.currentLayoutId = null;
        await Layouts.show();
      }
    }
    await this.persist();
    this.render();
  },
  async persist() {
    try {
      await fetch('/api/layouts/tabs', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openTabs: App.openTabs, active: App.currentLayoutId }),
      });
    } catch (e) {}
  },
  async refreshMeta() {
    const data = await Layouts.apiList();
    App.layoutsMeta = (data && data.layouts) || [];
  },
};

// Persist current symbol/TF into the active layout's state (debounced).
let _layoutStateTimer = null;
function schedulePersistLayoutState() {
  if (!App.currentLayoutId) return;
  if (_layoutStateTimer) clearTimeout(_layoutStateTimer);
  _layoutStateTimer = setTimeout(() => {
    _layoutStateTimer = null;
    Layouts.apiPutState(App.currentLayoutId, {
      currentSymbol: App.currentSymbol,
      currentTF: App.currentTF,
    });
  }, 500);
}

// ----- Centered loading modal -----
const Loading = {
  el: null,
  textEl: null,
  show(msg) {
    if (msg == null) {
      msg = (window.I18n && window.I18n.t) ? window.I18n.t('common.loading') : '載入中…';
    }
    this.el = this.el || document.getElementById('loading-modal');
    this.textEl = this.textEl || document.getElementById('loading-text');
    if (this.textEl) this.textEl.textContent = msg;
    if (this.el) {
      this.el.classList.remove('hidden');
      this.el.setAttribute('aria-hidden', 'false');
    }
  },
  hide() {
    this.el = this.el || document.getElementById('loading-modal');
    if (this.el) {
      this.el.classList.add('hidden');
      this.el.setAttribute('aria-hidden', 'true');
    }
  },
};

// ----- Top-of-screen toast -----
const Toast = {
  el: null,
  _timer: null,
  show(msg, kind = '', ms = 2200) {
    this.el = this.el || document.getElementById('toast');
    if (!this.el) return;
    this.el.textContent = msg;
    this.el.className = 'toast' + (kind ? ' ' + kind : '');
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this.el.classList.add('hidden');
    }, ms);
  },
};

// ----- Rescan: load any new symbol files without restarting the app -----
async function rescanDataDir() {
  // Spec i18n §3.12: every visible string in this flow goes through
  // the dictionary. Per-locale list joiner ('、' vs ', ') comes from
  // app.scanJoinComma so the result fragment reads naturally.
  const t_ = (key, vars) => (window.I18n && window.I18n.t)
    ? window.I18n.t(key, vars) : key;
  Loading.show(t_('app.scanInProgress'));
  try {
    const r = await fetch('/api/data_dir/rescan', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    App.symbols = Array.isArray(j.symbols) ? j.symbols : [];
    const added = j.added || [];
    const removed = j.removed || [];

    const joiner = t_('app.scanJoinComma');
    const addedStr   = added.join(joiner);
    const removedStr = removed.join(joiner);

    // Surface the actual symbol names in the loading modal so the user sees
    // what was picked up BEFORE the modal closes.
    let resultMsg;
    if (added.length > 0 && removed.length > 0) {
      resultMsg = t_('app.scanResultBoth', { added: addedStr, removed: removedStr });
    } else if (added.length > 0) {
      resultMsg = t_('app.scanResultAdded', { added: addedStr });
    } else if (removed.length > 0) {
      resultMsg = t_('app.scanResultRemoved', { removed: removedStr });
    } else {
      resultMsg = t_('app.scanResultNone');
    }
    Loading.show(resultMsg);

    // Hold briefly so the user can read the result, then close modal + toast.
    await new Promise(r => setTimeout(r, 1200));

    if (added.length > 0 && removed.length > 0) {
      Toast.show(t_('app.scanLoadedNRemovedM', { n: added.length, m: removed.length }), 'success');
    } else if (added.length > 0) {
      Toast.show(t_('app.scanLoadedN', { n: added.length }), 'success');
    } else if (removed.length > 0) {
      Toast.show(t_('app.scanRemovedM', { m: removed.length }), 'success');
    }

    if (SymSearch.isOpen()) SymSearch.render();
    return j;
  } catch (e) {
    Loading.show(t_('app.scanFailed', { err: (e.message || e) }));
    await new Promise(r => setTimeout(r, 1500));
    Toast.show(t_('app.scanFailedShort'), 'error', 3500);
    throw e;
  } finally {
    Loading.hide();
  }
}
App.rescanDataDir = rescanDataDir;

// ----- Position-tool settings (account size / risk % / rounding mode) -----
// Lives at window.PositionConfig so drawing.js's long/short overlays can
// read live values when computing Qty / P/L. When the user saves new
// settings we re-render existing position overlays so figures update too.
const DEFAULT_POSITION_CONFIG = {
  account_size: 10000,
  default_risk_percent: 2.0,
  rounding_mode: 'floor',
  symbol_override: null,
};
window.PositionConfig = { ...DEFAULT_POSITION_CONFIG };

async function loadPositionConfig() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    window.PositionConfig = { ...DEFAULT_POSITION_CONFIG, ...j };
  } catch (e) {
    console.warn('[position-config] load failed, using defaults:', e);
  }
}

const PositionSettings = {
  el: null,
  init() {
    this.el = document.getElementById('position-settings-popover');
    if (!this.el) return;
    // Populate the symbol-override dropdown from SymbolSpecs.
    const sel = document.getElementById('ps-symbol-override');
    if (sel && window.SymbolSpecs) {
      // Keep the leading "auto-detect" option, append known symbols.
      const known = window.SymbolSpecs.listSymbols();
      for (const sym of known) {
        const opt = document.createElement('option');
        opt.value = sym;
        const spec = window.SymbolSpecs.getSpec(sym);
        opt.textContent = `${sym} — ${spec.displayName}`;
        sel.appendChild(opt);
      }
    }
    // Wire up buttons.
    const gear = document.getElementById('btn-position-settings');
    if (gear) gear.addEventListener('click', () => this.open());
    document.getElementById('ps-close').addEventListener('click', () => this.close());
    document.getElementById('ps-save').addEventListener('click', () => this.save());
    document.getElementById('ps-reset').addEventListener('click', () => this.reset());
    // Esc closes.
    document.addEventListener('keydown', (e) => {
      if (this.isOpen() && e.key === 'Escape') {
        this.close();
        e.preventDefault();
      }
    });
  },
  isOpen() {
    return this.el && !this.el.classList.contains('hidden');
  },
  open() {
    if (!this.el) return;
    const cfg = window.PositionConfig || DEFAULT_POSITION_CONFIG;
    document.getElementById('ps-account-size').value = cfg.account_size;
    document.getElementById('ps-risk-pct').value = cfg.default_risk_percent;
    document.getElementById('ps-rounding').value = cfg.rounding_mode || 'floor';
    document.getElementById('ps-symbol-override').value = cfg.symbol_override || '';
    this.setStatus('');
    this.el.classList.remove('hidden');
    this.el.setAttribute('aria-hidden', 'false');
  },
  close() {
    if (!this.el) return;
    this.el.classList.add('hidden');
    this.el.setAttribute('aria-hidden', 'true');
  },
  reset() {
    document.getElementById('ps-account-size').value = DEFAULT_POSITION_CONFIG.account_size;
    document.getElementById('ps-risk-pct').value = DEFAULT_POSITION_CONFIG.default_risk_percent;
    document.getElementById('ps-rounding').value = DEFAULT_POSITION_CONFIG.rounding_mode;
    document.getElementById('ps-symbol-override').value = '';
    const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
    this.setStatus(t_('panel.settings.statusReset'));
  },
  async save() {
    const payload = {
      account_size: parseFloat(document.getElementById('ps-account-size').value) || 0,
      default_risk_percent: parseFloat(document.getElementById('ps-risk-pct').value) || 0,
      rounding_mode: document.getElementById('ps-rounding').value,
      symbol_override: document.getElementById('ps-symbol-override').value || null,
    };
    const t_ = (k, vars) => (window.I18n && window.I18n.t) ? window.I18n.t(k, vars) : k;
    this.setStatus(t_('panel.settings.statusSaving'));
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail.detail || ('HTTP ' + r.status));
      }
      const saved = await r.json();
      window.PositionConfig = { ...DEFAULT_POSITION_CONFIG, ...saved };
      // Re-render any existing position overlays so they reflect the new config.
      if (window.Drawing && window.Drawing.refreshPositionOverlays) {
        window.Drawing.refreshPositionOverlays();
      }
      this.setStatus(t_('panel.settings.statusSaved'), 'success');
      setTimeout(() => this.close(), 600);
    } catch (e) {
      this.setStatus(t_('panel.settings.statusSaveFailed', { err: (e.message || e) }), 'error');
    }
  },
  setStatus(msg, kind = '') {
    const el = document.getElementById('ps-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'ps-status' + (kind ? ' ' + kind : '');
  },
};
App.PositionSettings = PositionSettings;

// ----- Per-overlay position settings (right-click → 設定 on long/short) ---
// Dedicated dialog (separate from the existing #settings-panel which is built
// for trendline/rect/measure). Opens with Live preview, 取消 reverts via
// snapshot, 確認 just closes.
const PositionOverlaySettings = {
  el: null,
  currentOverlay: null,
  snapshot: null,
  init() {
    this.el = document.getElementById('position-overlay-settings');
    if (!this.el) return;
    document.getElementById('pos-ov-close').addEventListener('click', () => this.cancel());
    document.getElementById('pos-cancel').addEventListener('click', () => this.cancel());
    document.getElementById('pos-confirm').addEventListener('click', () => this.confirm());
    // Tab switching
    this.el.querySelectorAll('.tab[data-pos-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.posTab));
    });
    // Color swatches in the 樣式 tab — reuse the existing palette /
    // custom / opacity popover via Drawing.openGenericColorPicker. Each
    // swatch stores its current hex on `dataset.color` AND its opacity
    // on `dataset.opacity` so the slider's value is preserved between
    // popover opens; applyLive reads both to push styles into the overlay.
    [['pos-style-line-color',   '#ffd54f'],
     ['pos-style-stop-color',   '#ef5350'],
     ['pos-style-target-color', '#26a69a']].forEach(([id, def]) => {
      const sw = document.getElementById(id);
      if (!sw) return;
      sw.dataset.color = def;
      sw.dataset.opacity = '1';
      sw.style.background = def;
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        const curHex = sw.dataset.color || def;
        const curOp  = parseFloat(sw.dataset.opacity || '1');
        if (window.Drawing && window.Drawing.openGenericColorPicker) {
          window.Drawing.openGenericColorPicker(sw, curHex, curOp, (hex, op) => {
            sw.dataset.color = hex;
            sw.dataset.opacity = String(op);
            // Drawing.setActiveColor already paints the swatch bg with
            // hexToRgba(hex, op), so we don't have to here.
            this.applyLive(id);
          });
        }
      });
    });

    // Drag the dialog by its header. Mirrors the mainsettings panel's
    // makePanelDraggable behavior — once the user grabs it, we kill the
    // CSS transform and pin via left/top so the position is stable.
    this._installDrag();

    // The settings-panel's outside-click handler only fires while THAT
    // panel is open, so when the user clicks outside the color popover
    // while the position dialog is open it would otherwise stay
    // open. Mirror the same behavior here.
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
    // Live update on every input/select change
    const liveIds = [
      'pos-account-size', 'pos-lot-size', 'pos-risk-percent',
      'pos-entry-price', 'pos-leverage', 'pos-qty-precision',
      'pos-target-ticks', 'pos-target-price',
      'pos-stop-ticks', 'pos-stop-price',
      'pos-visible-cb', 'pos-locked-cb',
      // 樣式 tab — color swatches are wired below, only the non-color
      // controls go through the standard input/change listener.
      'pos-style-font-size', 'pos-style-show-price-label',
    ];
    for (const id of liveIds) {
      const el = document.getElementById(id);
      if (!el) continue;
      const ev = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
      el.addEventListener(ev, () => this.applyLive(id));
    }
    // Esc closes (= 取消, reverting via snapshot).
    document.addEventListener('keydown', (e) => {
      if (this.isOpen() && e.key === 'Escape') {
        this.cancel();
        e.preventDefault();
      }
    });
  },
  isOpen() {
    return this.el && !this.el.classList.contains('hidden');
  },
  open(overlay) {
    if (!this.el || !overlay) return;
    this.currentOverlay = overlay;
    this.snapshot = {
      points: overlay.points ? JSON.parse(JSON.stringify(overlay.points)) : [],
      extendData: overlay.extendData ? JSON.parse(JSON.stringify(overlay.extendData)) : {},
      visible: overlay.visible !== false,
      lock: !!overlay.lock,
    };
    const params = (overlay.extendData && overlay.extendData.position) || {};
    const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
    document.getElementById('pos-ov-title').textContent =
      overlay.name === 'short_position' ? t_('panel.position.namedShort') : t_('panel.position.namedLong');
    document.getElementById('pos-account-size').value = params.accountSize ?? 10000;
    document.getElementById('pos-lot-size').value     = params.lotSize ?? 1;
    document.getElementById('pos-risk-percent').value = params.riskPercent ?? 2;
    document.getElementById('pos-leverage').value     = params.leverage ?? 1;
    document.getElementById('pos-qty-precision').value = params.qtyPrecision || 'default';
    document.getElementById('pos-visible-cb').checked = overlay.visible !== false;
    document.getElementById('pos-locked-cb').checked  = !!overlay.lock;
    // 樣式 tab — fall back to defaults if styles haven't been touched yet.
    const ovStyles = (overlay.extendData && overlay.extendData.position
                      && overlay.extendData.position.styles) || {};
    const _hex2rgba = (hex, op) => {
      // Mirror of drawing.js's hexToRgba — used to seed the swatch bg
      // visually so it reflects the saved opacity on dialog open.
      if (!hex || !hex.startsWith('#')) return hex;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${op})`;
    };
    const seedSwatch = (id, def) => {
      const sw = document.getElementById(id);
      if (!sw) return;
      const hex = ovStyles[def.colorKey]   || def.fallback;
      const op  = (ovStyles[def.opacityKey] != null) ? ovStyles[def.opacityKey] : 1;
      sw.dataset.color   = hex;
      sw.dataset.opacity = String(op);
      sw.style.background = _hex2rgba(hex, op);
    };
    seedSwatch('pos-style-line-color',   { colorKey: 'lineColor',   opacityKey: 'lineOpacity',   fallback: '#ffd54f' });
    seedSwatch('pos-style-stop-color',   { colorKey: 'stopColor',   opacityKey: 'stopOpacity',   fallback: '#ef5350' });
    seedSwatch('pos-style-target-color', { colorKey: 'targetColor', opacityKey: 'targetOpacity', fallback: '#26a69a' });
    document.getElementById('pos-style-font-size').value    = String(ovStyles.fontSize || 12);
    document.getElementById('pos-style-show-price-label').checked =
      ovStyles.showPriceLabel !== false;
    const points = overlay.points || [];
    if (points.length >= 3) {
      // 4-point layout (new): [0]=entry-left [1]=entry-right [2]=target [3]=stop
      // 3-point layout (legacy): [0]=entry [1]=target [2]=stop
      const fourPt = points.length >= 4;
      const tIdx = fourPt ? 2 : 1;
      const sIdx = fourPt ? 3 : 2;
      document.getElementById('pos-entry-price').value  = points[0].value;
      document.getElementById('pos-target-price').value = points[tIdx].value;
      document.getElementById('pos-stop-price').value   = points[sIdx].value;
      const tickSize = params.tickSize || 0.25;
      document.getElementById('pos-target-ticks').value =
        Math.round(Math.abs(points[tIdx].value - points[0].value) / tickSize);
      document.getElementById('pos-stop-ticks').value =
        Math.round(Math.abs(points[sIdx].value - points[0].value) / tickSize);
    }
    this.switchTab('input');
    this._recenter();
    this.el.classList.remove('hidden');
    this.el.setAttribute('aria-hidden', 'false');
  },
  // Re-center the dialog horizontally + pin to a stable top each time it
  // opens. Wipes any inline left/top from a previous drag so the user
  // always starts from the same place.
  _recenter() {
    if (!this.el) return;
    this.el.style.left = '';
    this.el.style.top = '';
    this.el.style.transform = '';   // CSS default kicks back in
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
  switchTab(tab) {
    this.el.querySelectorAll('.tab[data-pos-tab]').forEach(b => {
      b.classList.toggle('active', b.dataset.posTab === tab);
    });
    this.el.querySelectorAll('.pos-tab-body').forEach(s => {
      s.classList.toggle('hidden', s.dataset.posTab !== tab);
    });
  },
  // Read every field, push to overlay. `changedId` lets us link Ticks ↔ 價格.
  applyLive(changedId) {
    if (!this.currentOverlay || !window.Drawing || !window.Drawing.chart) return;
    const ov = this.currentOverlay;
    const side = ov.name === 'short_position' ? 'short' : 'long';

    const accountSize  = parseFloat(document.getElementById('pos-account-size').value) || 0;
    const lotSize      = parseFloat(document.getElementById('pos-lot-size').value) || 1;
    const riskPercent  = parseFloat(document.getElementById('pos-risk-percent').value) || 0;
    const leverage     = parseFloat(document.getElementById('pos-leverage').value) || 1;
    const qtyPrecision = document.getElementById('pos-qty-precision').value || 'default';
    const tickSize     = (ov.extendData && ov.extendData.position && ov.extendData.position.tickSize) || 0.25;
    const visible      = document.getElementById('pos-visible-cb').checked;
    const locked       = document.getElementById('pos-locked-cb').checked;

    let entryPrice  = parseFloat(document.getElementById('pos-entry-price').value);
    let targetPrice = parseFloat(document.getElementById('pos-target-price').value);
    let stopPrice   = parseFloat(document.getElementById('pos-stop-price').value);

    // Ticks ↔ price coupling — when user types in Ticks, recompute the price
    // (sign depends on long/short). When user types price directly, recompute
    // Ticks. We avoid feedback loops by acting only on the FIELD that changed.
    if (changedId === 'pos-target-ticks') {
      const ticks = parseFloat(document.getElementById('pos-target-ticks').value) || 0;
      const sign = side === 'long' ? 1 : -1;
      targetPrice = entryPrice + sign * ticks * tickSize;
      document.getElementById('pos-target-price').value = targetPrice.toFixed(2);
    } else if (changedId === 'pos-target-price') {
      const ticks = Math.round(Math.abs(targetPrice - entryPrice) / tickSize);
      document.getElementById('pos-target-ticks').value = ticks;
    } else if (changedId === 'pos-stop-ticks') {
      const ticks = parseFloat(document.getElementById('pos-stop-ticks').value) || 0;
      const sign = side === 'long' ? -1 : 1;        // stop on opposite side of target
      stopPrice = entryPrice + sign * ticks * tickSize;
      document.getElementById('pos-stop-price').value = stopPrice.toFixed(2);
    } else if (changedId === 'pos-stop-price') {
      const ticks = Math.round(Math.abs(stopPrice - entryPrice) / tickSize);
      document.getElementById('pos-stop-ticks').value = ticks;
    } else if (changedId === 'pos-entry-price') {
      // Re-derive Ticks for both target/stop (price stays where user has it).
      document.getElementById('pos-target-ticks').value =
        Math.round(Math.abs(targetPrice - entryPrice) / tickSize);
      document.getElementById('pos-stop-ticks').value =
        Math.round(Math.abs(stopPrice - entryPrice) / tickSize);
    }

    // Read 樣式 fields. Color swatches store their hex on dataset.color
    // and slider opacity on dataset.opacity (both set by the popover's
    // onChange callback). Other fields are standard inputs / checkboxes.
    const _readSwatch = (id, defHex) => {
      const sw = document.getElementById(id);
      return {
        hex: (sw && sw.dataset.color) || defHex,
        op:  parseFloat((sw && sw.dataset.opacity) || '1'),
      };
    };
    const lineSw   = _readSwatch('pos-style-line-color',   '#ffd54f');
    const stopSw   = _readSwatch('pos-style-stop-color',   '#ef5350');
    const targetSw = _readSwatch('pos-style-target-color', '#26a69a');
    const styles = {
      lineColor:      lineSw.hex,
      lineOpacity:    Number.isFinite(lineSw.op)   ? lineSw.op   : 1,
      stopColor:      stopSw.hex,
      stopOpacity:    Number.isFinite(stopSw.op)   ? stopSw.op   : 1,
      targetColor:    targetSw.hex,
      targetOpacity:  Number.isFinite(targetSw.op) ? targetSw.op : 1,
      fontSize:       parseInt(document.getElementById('pos-style-font-size').value, 10) || 12,
      showPriceLabel: document.getElementById('pos-style-show-price-label').checked,
    };

    const positionParams = {
      accountSize, lotSize, riskPercent, leverage, tickSize, qtyPrecision,
      styles,
    };
    const existingPoints = ov.points || [];
    const fourPt = existingPoints.length >= 4;
    const tIdx = fourPt ? 2 : 1;
    const sIdx = fourPt ? 3 : 2;
    const safeEntry  = Number.isFinite(entryPrice)  ? entryPrice  : (existingPoints[0] && existingPoints[0].value);
    const safeTarget = Number.isFinite(targetPrice) ? targetPrice : (existingPoints[tIdx] && existingPoints[tIdx].value);
    const safeStop   = Number.isFinite(stopPrice)   ? stopPrice   : (existingPoints[sIdx] && existingPoints[sIdx].value);
    let newPoints;
    if (fourPt) {
      // 4-point: entry value mirrored across [0] and [1].
      newPoints = [
        { ...existingPoints[0], value: safeEntry },
        { ...existingPoints[1], value: safeEntry },
        { ...existingPoints[2], value: safeTarget },
        { ...existingPoints[3], value: safeStop },
      ];
    } else {
      newPoints = [
        { ...(existingPoints[0] || {}), value: safeEntry },
        { ...(existingPoints[1] || {}), value: safeTarget },
        { ...(existingPoints[2] || {}), value: safeStop },
      ];
    }
    const extendData = { ...(ov.extendData || {}), position: positionParams };

    try {
      window.Drawing.chart.overrideOverlay({
        id: ov.id, points: newPoints, extendData, visible, lock: locked,
      });
      ov.points = newPoints;
      ov.extendData = extendData;
      ov.visible = visible;
      ov.lock = locked;
      // Mirror to registry so persistence picks up the latest.
      if (window.Drawing.updateTrackedOverlay) {
        window.Drawing.updateTrackedOverlay(ov.id, {
          points: newPoints, extendData, visible, lock: locked,
        });
      }
    } catch (e) {
      console.warn('[position-overlay-settings] applyLive failed', e);
    }
  },
  cancel() {
    if (this.snapshot && this.currentOverlay && window.Drawing && window.Drawing.chart) {
      try {
        window.Drawing.chart.overrideOverlay({
          id: this.currentOverlay.id,
          points: this.snapshot.points,
          extendData: this.snapshot.extendData,
          visible: this.snapshot.visible,
          lock: this.snapshot.lock,
        });
        this.currentOverlay.points = this.snapshot.points;
        this.currentOverlay.extendData = this.snapshot.extendData;
        this.currentOverlay.visible = this.snapshot.visible;
        this.currentOverlay.lock = this.snapshot.lock;
      } catch (e) { /* ignore */ }
    }
    this.close();
  },
  confirm() {
    // Live preview already applied — just dismiss.
    this.close();
  },
  close() {
    if (!this.el) return;
    // Tear down the color popover too — its anchor swatch is about to go
    // hidden so leaving it open would orphan it on screen.
    if (window.Drawing && window.Drawing.hideColorPopover) {
      window.Drawing.hideColorPopover();
    }
    this.el.classList.add('hidden');
    this.el.setAttribute('aria-hidden', 'true');
    this.currentOverlay = null;
    this.snapshot = null;
  },
};
window.PositionOverlaySettings = PositionOverlaySettings;
App.PositionOverlaySettings = PositionOverlaySettings;

// ----- Onboarding (shown when market_data/ is empty) -----
const Onboarding = {
  el: null,
  statusEl: null,
  async check() {
    try {
      const r = await fetch('/api/data_dir');
      const j = await r.json();
      if ((j.symbol_count || 0) === 0) {
        this.show(j.dir || '');
        return true;
      }
    } catch (e) {
      console.error('[onboarding] data_dir check failed', e);
    }
    return false;
  },
  show(dirPath) {
    this.el = document.getElementById('onboarding-overlay');
    this.statusEl = document.getElementById('onboarding-status');
    if (!this.el) return;
    const pathEl = document.getElementById('onboarding-path-text');
    if (pathEl) pathEl.textContent = dirPath || '(unknown)';
    this.el.classList.remove('hidden');
    this.el.setAttribute('aria-hidden', 'false');

    const copyBtn = document.getElementById('onboarding-copy');
    if (copyBtn && !copyBtn._wired) {
      copyBtn._wired = true;
      copyBtn.addEventListener('click', async () => {
        const t_ = (k) => (window.I18n && window.I18n.t) ? window.I18n.t(k) : k;
        try {
          await navigator.clipboard.writeText(dirPath);
          copyBtn.textContent = t_('common.copied');
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = t_('onboarding.copy');
            copyBtn.classList.remove('copied');
          }, 1500);
        } catch {}
      });
    }
    const t_ = (k, vars) => (window.I18n && window.I18n.t) ? window.I18n.t(k, vars) : k;
    const openBtn = document.getElementById('onboarding-open');
    if (openBtn && !openBtn._wired) {
      openBtn._wired = true;
      openBtn.addEventListener('click', async () => {
        try {
          await fetch('/api/data_dir/open', { method: 'POST' });
        } catch (e) {
          this.setStatus(t_('onboarding.errOpenFailed', { err: e }), 'error');
        }
      });
    }
    const reloadBtn = document.getElementById('onboarding-reload');
    if (reloadBtn && !reloadBtn._wired) {
      reloadBtn._wired = true;
      reloadBtn.addEventListener('click', async () => {
        // Show the big centered Loading modal in addition to the inline
        // onboarding status — server-side init_cache can take seconds
        // for large data folders, and a tiny inline status string under
        // the button is easy to miss. Loading stays visible across the
        // location.reload() teardown until the new page paints.
        this.setStatus(t_('onboarding.statusReloading'));
        Loading.show(t_('onboarding.statusReloading'));
        try {
          const r = await fetch('/api/data_dir/reload', { method: 'POST' });
          const j = await r.json();
          const found = (j.symbols || []).length;
          if (found > 0) {
            this.setStatus(t_('onboarding.statusFound', { n: found }), 'success');
            // Keep Loading visible through reload — gives the user
            // continuous feedback instead of a blank page during the
            // browser's reload pass.
            setTimeout(() => location.reload(), 600);
          } else {
            this.setStatus(t_('onboarding.statusEmpty'), 'error');
            Loading.hide();
          }
        } catch (e) {
          this.setStatus(t_('onboarding.statusFailed', { err: e }), 'error');
          Loading.hide();
        }
      });
    }
  },
  setStatus(msg, kind = '') {
    if (!this.statusEl) return;
    this.statusEl.textContent = msg;
    this.statusEl.className = 'onboarding-status' + (kind ? ' ' + kind : '');
  },
};

// ----- Boot -----
// Wire the topbar 「開啟資料夾」 + 「重新載入」 buttons. Same endpoints the
// Onboarding card calls, but always reachable from the main chart UI — on
// macOS the market_data/ folder lives under ~/Library and is awkward to
// find via Finder, so this surfaces the same action without forcing the
// user to drain all symbols first.
function _initDataActionButtons() {
  const t_ = (k, vars) => (window.I18n && window.I18n.t) ? window.I18n.t(k, vars) : k;
  const openBtn = document.getElementById('btn-open-data');
  if (openBtn && !openBtn._wired) {
    openBtn._wired = true;
    openBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/data_dir/open', { method: 'POST' });
      } catch (e) {
        Toast.show(t_('onboarding.errOpenFailed', { err: e }), 'error');
      }
    });
  }
  const reloadBtn = document.getElementById('btn-reload-data');
  if (reloadBtn && !reloadBtn._wired) {
    reloadBtn._wired = true;
    reloadBtn.addEventListener('click', async () => {
      // Same pattern as Onboarding.btnReload — show the centered Loading
      // modal during the server re-init (can take seconds for big folders)
      // and ride it through the page reload so the user gets continuous
      // feedback instead of a blank tab.
      Loading.show(t_('onboarding.statusReloading'));
      try {
        const r = await fetch('/api/data_dir/reload', { method: 'POST' });
        const j = await r.json();
        const found = (j.symbols || []).length;
        if (found > 0) {
          setTimeout(() => location.reload(), 400);
        } else {
          Loading.hide();
          Toast.show(t_('onboarding.statusEmpty'), 'error');
        }
      } catch (e) {
        Loading.hide();
        Toast.show(t_('onboarding.statusFailed', { err: e }), 'error');
      }
    });
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  initChart();
  initPagination();
  // Data-folder shortcuts on the main toolbar (wire early so they work
  // even before symbols load — useful when the user just installed the
  // app and needs to find the data folder).
  _initDataActionButtons();

  // i18n-spec §5.3: fetch /api/config and apply uiLang BEFORE any panel
  // module's init() runs. Modules' init paths call I18n.t at construction
  // (e.g. button labels, kind maps), so the language must be settled
  // before they read. We also reuse the response for window.PositionConfig
  // — same endpoint used to be fetched twice (once here, once in
  // loadPositionConfig); fold them into one round-trip.
  let _bootCfg = null;
  try {
    const r = await fetch('/api/config');
    if (r.ok) _bootCfg = await r.json();
  } catch (e) { /* network error → keep zh defaults */ }
  // Language alignment between localStorage (instant first-paint, set
  // by i18n.js IIFE) and server config:
  //   - localStorage HAS a stored choice → that's the user's explicit
  //     pick on this machine; it wins. If server disagrees (stale
  //     config, user toggled in a different session, etc.), POST our
  //     value to align the server. This is the case that broke before:
  //     server's fresh `uiLang: 'zh'` default would overwrite the
  //     user's cached 'en' on every boot, leaving them with a Chinese
  //     UI and an English dropdown.
  //   - localStorage has NO stored choice (first run on this machine)
  //     → trust the server's value if present.
  if (_bootCfg && (_bootCfg.uiLang === 'zh' || _bootCfg.uiLang === 'en')
      && window.I18n && window.I18n.lang !== _bootCfg.uiLang) {
    if (window.I18n.hadStoredLang) {
      // localStorage wins — push our value to the server. Fire-and-
      // forget; we don't want to wait for the round-trip on boot.
      try {
        fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uiLang: window.I18n.lang }),
        }).catch(() => {});
      } catch (e) { /* ignore */ }
    } else {
      // No local preference → honor the server. setLang triggers
      // applyDOM + i18n:change so the page actually re-renders.
      try { await window.I18n.setLang(_bootCfg.uiLang); } catch (e) { /* ignore */ }
    }
  }
  // Merge user-saved symbol-spec overrides on top of the built-in
  // defaults BEFORE SimController.init / SimPanel.init run — those
  // modules cache the spec at boot. Network failure here is silent
  // (built-ins still work, user just doesn't see their tweaks).
  if (window.SymbolSpecs && window.SymbolSpecs.loadOverrides) {
    try { await window.SymbolSpecs.loadOverrides(); } catch (e) { /* ignore */ }
  }
  // Mirror config fetch into PositionConfig so the second call below is
  // a no-op when this one succeeded. loadPositionConfig still runs as a
  // safety retry if this fetch failed.
  if (_bootCfg) {
    window.PositionConfig = { ...DEFAULT_POSITION_CONFIG, ..._bootCfg };
  }

  await loadSymbols();

  // Drain cache-invalidation events from the server. data_service
  // records a 'source_changed' event whenever a .txt file's mtime/size
  // differs from what the .cache.pkl was written against — i.e. the
  // user edited the source outside the app and we silently re-parsed.
  // Surface this as a Toast so they know the reload happened. Fire-
  // and-forget; cosmetic only.
  (async () => {
    try {
      const r = await fetch('/api/data_events');
      if (!r.ok) return;
      const j = await r.json();
      const changed = (j.events || []).filter((e) => e.kind === 'source_changed');
      if (!changed.length) return;
      const t_ = (k, vars) => (window.I18n && window.I18n.t)
        ? window.I18n.t(k, vars) : k;
      const join = t_('app.scanJoinComma');
      const symbols = changed.map((e) => e.symbol).join(join);
      const msg = changed.length === 1
        ? t_('app.dataChangedOne',  { symbols })
        : t_('app.dataChangedMany', { symbols, n: changed.length });
      Toast.show(msg, 'success', 5000);
    } catch (e) { /* ignore */ }
  })();

  // No symbols loaded → market_data/ is empty. Show onboarding + halt bootstrap.
  // The user will either drop files + reload (which restarts this whole flow)
  // or use the 📁 open-folder button.
  if (!App.symbols || App.symbols.length === 0) {
    await Onboarding.check();
    return;
  }

  SymSearch.init();
  Layouts.init();
  TabBar.init();
  PositionSettings.init();
  PositionOverlaySettings.init();
  // Per-overlay fibonacci settings — mirrors PositionOverlaySettings'
  // shape (init wires DOM once, showSettings → FiboSettings.open()).
  if (window.FiboSettings && window.FiboSettings.init) {
    try { window.FiboSettings.init(); } catch (e) { /* ignore */ }
  }
  // Position-tool config — already fetched as part of the i18n boot
  // (above). Run loadPositionConfig as a fallback-only retry path
  // when the upfront fetch failed (no `_bootCfg`). This preserves the
  // original behaviour of "Qty re-renders after config arrives".
  if (!_bootCfg) {
    loadPositionConfig().then(() => {
      if (window.Drawing && window.Drawing.refreshPositionOverlays) {
        window.Drawing.refreshPositionOverlays();
      }
    });
  } else if (window.Drawing && window.Drawing.refreshPositionOverlays) {
    // Config already in memory → refresh once now so position overlays
    // pick up account size / risk before the user touches them.
    window.Drawing.refreshPositionOverlays();
  }

  // Hook up drawing/replay modules BEFORE opening any layout so they exist
  // when switchSymbol / openLayout fire their hooks.
  if (window.Drawing) window.Drawing.init(App.chart);
  if (window.Replay) window.Replay.init(App.chart);

  // branching-replay-spec §7.1: BranchEngine must boot BEFORE SimController
  // so that the activeBranchId is available the very first time
  // SimController.placeOrder runs (sim_panel reads
  // BranchEngine.activeBranchId to tag every order). Loads persisted
  // branch session from localStorage if present, else seeds a default
  // 'main' branch.
  if (window.BranchEngine) window.BranchEngine.init();

  // Sim engine (step 1) + trading panel UI (step 2). Order matters:
  // SimController.init creates the engine + reads the symbol spec, then
  // SimPanel.init wires the DOM (which calls Controller methods).
  if (window.SimController) window.SimController.init();
  if (window.SimPanel) window.SimPanel.init();
  if (window.BranchPanel) window.BranchPanel.init();
  // Mini chart (branching-replay-spec §5.4) — secondary KLineChart
  // below main, lazy-init on first show. Must come AFTER BranchEngine
  // so its event subscriptions land properly.
  if (window.MiniChart) window.MiniChart.init();
  // Trade history drawer (TradingView 交易清單) — branch-aware.
  if (window.SimHistory) window.SimHistory.init();
  // Symbol-settings modal (商品規格 tab inside chart-settings). Wires
  // its own DOM listeners; safe to call after the modal markup exists.
  if (window.SymbolSettings) window.SymbolSettings.init();

  // Fetch layouts list + restore tab bar state.
  const data = await Layouts.apiList();
  App.layoutsMeta = (data && data.layouts) || [];
  const validIds = new Set(App.layoutsMeta.map(l => l.id));
  App.openTabs = ((data && data.openTabs) || []).filter(id => validIds.has(id));
  const lastId = data && data.lastLayoutId;
  // If no saved tabs, seed with lastLayoutId so the user sees at least one.
  if (!App.openTabs.length && lastId && validIds.has(lastId)) {
    App.openTabs.push(lastId);
  }
  TabBar.render();

  if (lastId && validIds.has(lastId)) {
    await openLayout(lastId);
  } else if (App.openTabs.length) {
    await openLayout(App.openTabs[0]);
  } else if (App.layoutsMeta.length) {
    await openLayout(App.layoutsMeta[0].id);
  } else {
    await Layouts.show();
  }

  window.addEventListener('resize', () => {
    if (App.chart) App.chart.resize();
  });

  // Last-chance flush when the user closes the tab. beforeunload runs
  // synchronously so we can't await — sendBeacon ships the bytes
  // even after the page tears down. Fallback: keepalive fetch.
  window.addEventListener('beforeunload', () => {
    try {
      const lid = App.currentLayoutId;
      if (!lid) return;
      const beacon = (url, body) => {
        const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
        if (navigator.sendBeacon) navigator.sendBeacon(url, blob);
        else fetch(url, { method: 'PUT', body: blob, keepalive: true }).catch(() => {});
      };
      // Branch session
      if (window.BranchEngine && window.BranchEngine.snapshotForBeacon) {
        const snap = window.BranchEngine.snapshotForBeacon();
        if (snap) beacon(`/api/branch?layout=${encodeURIComponent(lid)}`, snap);
      }
      // Sim engine state (per current symbol)
      if (window.SimController && window.SimController._dirty
          && window.SimController.engine && window.SimController._symbol) {
        const snap = window.SimController.engine.serialize();
        beacon(
          `/api/sim?layout=${encodeURIComponent(lid)}&symbol=${encodeURIComponent(window.SimController._symbol)}`,
          snap);
      }
    } catch (e) { /* swallow — page is closing */ }
  });

  // Keep the FastAPI idle watchdog quiet while the page is open. Without
  // this a browser tab that's just staring at the chart racks up no HTTP
  // activity and the server self-terminates after CHART_VIEWER_IDLE_TIMEOUT
  // — then the next F5 hangs because port 8000 is dead. start.bat sets the
  // env var to 0 (disabled) but this ping is harmless if the watchdog is
  // off and saves the user when running uvicorn manually.
  setInterval(() => {
    fetch('/api/ping', { cache: 'no-store' }).catch(() => {});
  }, 60_000);
});

// ----- Expose helpers -----
App.loadTimeframe = loadTimeframe;
App.switchSymbol = switchSymbol;
App.openLayout = openLayout;
App.Layouts = Layouts;
App.schedulePersistLayoutState = schedulePersistLayoutState;
