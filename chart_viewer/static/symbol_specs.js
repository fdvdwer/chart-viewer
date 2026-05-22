/**
 * symbol_specs.js — Contract specs for position-sizing math.
 *
 *   pointValue        : Quote-currency profit/loss per 1.0 price-unit
 *                       move per 1 lot. For futures this is the published
 *                       contract spec; for spot products it's typically 1
 *                       per oz/unit.
 *   lotSize           : Base units per 1 lot (multiplier). Always 1 for
 *                       futures; for spot products = the broker contract
 *                       size (e.g. XAUUSD = 100 oz per lot).
 *   qtyStep           : Smallest tradable lot increment.
 *   tickSize          : Minimum price increment (used to express the
 *                       stop/target distance in ticks for the on-chart
 *                       label).
 *   spread            : Default bid/ask spread in price units. Used by
 *                       the order-simulation engine for market-fill
 *                       slippage (half-spread on the wrong side) and the
 *                       bid/ask display in the trading panel.
 *   slippageTicks     : Extra ticks added to a stop fill on top of the
 *                       trigger price — stops always slip in real
 *                       markets, so we model that here. 0 for spot.
 *   commissionPerSide : Quote-currency commission per round-turn side.
 *                       Subtracted from realised P/L when an entry or
 *                       exit fills.
 *   currency          : ISO-style currency code for P&L display
 *                       formatting. Default 'USD'. TXF uses 'NTD'.
 *                       Only affects display — pointValue / commission
 *                       are interpreted in this currency.
 *   displayName       : Human-readable label for the symbol picker.
 *   kind              : 'future' | 'spot' — affects unit terminology.
 *
 * Specs can be overridden per-symbol via the Symbol Settings modal,
 * persisted to user_data/symbol_specs.json. Built-in defaults below;
 * boot loads overrides via fetch('/api/symbol-specs') and merges.
 */
(function () {
  const BUILT_IN_SPECS = {
    // CME futures — lotSize = 1, pointValue is the contract spec.
    NQ:     { pointValue: 20,     lotSize: 1,   qtyStep: 1,    tickSize: 0.25,    spread: 0.25,    slippageTicks: 1, commissionPerSide: 0.50, currency: 'USD', displayName: 'E-mini Nasdaq-100',     kind: 'future' },
    MNQ:    { pointValue: 2,      lotSize: 1,   qtyStep: 1,    tickSize: 0.25,    spread: 0.25,    slippageTicks: 1, commissionPerSide: 0.10, currency: 'USD', displayName: 'Micro Nasdaq-100',      kind: 'future' },
    ES:     { pointValue: 50,     lotSize: 1,   qtyStep: 1,    tickSize: 0.25,    spread: 0.25,    slippageTicks: 1, commissionPerSide: 0.50, currency: 'USD', displayName: 'E-mini S&P 500',        kind: 'future' },
    MES:    { pointValue: 5,      lotSize: 1,   qtyStep: 1,    tickSize: 0.25,    spread: 0.25,    slippageTicks: 1, commissionPerSide: 0.10, currency: 'USD', displayName: 'Micro S&P 500',         kind: 'future' },
    GC:     { pointValue: 100,    lotSize: 1,   qtyStep: 1,    tickSize: 0.10,    spread: 0.10,    slippageTicks: 1, commissionPerSide: 0.50, currency: 'USD', displayName: 'COMEX Gold',            kind: 'future' },
    MGC:    { pointValue: 10,     lotSize: 1,   qtyStep: 1,    tickSize: 0.10,    spread: 0.10,    slippageTicks: 1, commissionPerSide: 0.10, currency: 'USD', displayName: 'Micro Gold',            kind: 'future' },
    CL:     { pointValue: 1000,   lotSize: 1,   qtyStep: 1,    tickSize: 0.01,    spread: 0.01,    slippageTicks: 1, commissionPerSide: 1.50, currency: 'USD', displayName: 'NYMEX Crude Oil',       kind: 'future' },
    EC:     { pointValue: 125000, lotSize: 1,   qtyStep: 1,    tickSize: 0.00005, spread: 0.00005, slippageTicks: 1, commissionPerSide: 2.00, currency: 'USD', displayName: 'CME Euro FX (6E)',      kind: 'future' },
    // TAIFEX — quote currency NTD (NT$200 per index point); typical
    // retail commission ~NT$50/side.
    TXF:    { pointValue: 200,    lotSize: 1,   qtyStep: 1,    tickSize: 1,       spread: 1,       slippageTicks: 1, commissionPerSide: 50,   currency: 'NTD', displayName: '台指期 TAIEX Futures', kind: 'future' },
    // Spot — pointValue = 1 USD per oz/unit, lotSize = broker contract size.
    // Spot has wider spread, no per-trade commission (broker is paid via spread).
    XAUUSD: { pointValue: 1,      lotSize: 100, qtyStep: 0.01, tickSize: 0.01,    spread: 0.30,    slippageTicks: 0, commissionPerSide: 0,    currency: 'USD', displayName: 'Spot Gold (100oz lot)', kind: 'spot' },
  };

  // Live merged map: starts as a deep clone of BUILT_IN_SPECS, then
  // loadOverrides / setOverride / removeOverride mutate it in place.
  // Existing read paths (getSpec / listSymbols / isKnownSymbol) read
  // this map without knowing about the override layer.
  const SYMBOL_SPECS = {};
  for (const [k, v] of Object.entries(BUILT_IN_SPECS)) SYMBOL_SPECS[k] = { ...v };

  const DEFAULT_SYMBOL = 'NQ';

  /**
   * Return the spec for a symbol code. Falls back to the default spec when
   * the symbol is unknown — callers should show a warning badge so the user
   * notices they are using fallback specs.
   */
  function getSpec(symbol) {
    if (!symbol) return SYMBOL_SPECS[DEFAULT_SYMBOL];
    if (SYMBOL_SPECS[symbol]) return SYMBOL_SPECS[symbol];
    // Strip trailing digits (e.g. "NQ1" → "NQ") and try again.
    const base = String(symbol).replace(/\d+$/, '').toUpperCase();
    if (SYMBOL_SPECS[base]) return SYMBOL_SPECS[base];
    return SYMBOL_SPECS[DEFAULT_SYMBOL];
  }

  /**
   * Returns true when the given chart symbol resolves directly (via the
   * digit-stripping rule) to a known spec — used to suppress the
   * "unknown symbol" warning badge in normal cases.
   */
  function isKnownSymbol(symbol) {
    if (!symbol) return false;
    if (SYMBOL_SPECS[symbol]) return true;
    const base = String(symbol).replace(/\d+$/, '').toUpperCase();
    return !!SYMBOL_SPECS[base];
  }

  function unitLabel(spec) {
    return (spec && spec.kind === 'spot') ? 'lots' : 'contracts';
  }

  /** Resolve a chart symbol like "TXF1" to the dictionary key "TXF". */
  function resolveBaseKey(symbol) {
    if (!symbol) return DEFAULT_SYMBOL;
    if (SYMBOL_SPECS[symbol]) return symbol;
    const base = String(symbol).replace(/\d+$/, '').toUpperCase();
    return SYMBOL_SPECS[base] ? base : symbol.toUpperCase();
  }

  // Allowed currency codes (display formatting only — NOT enforced for
  // the underlying numbers). Matches what the symbol-settings UI offers.
  const ALLOWED_CURRENCIES = ['USD', 'NTD', 'EUR', 'JPY', 'GBP', 'HKD', 'CNY', 'AUD', 'CAD'];

  // Format a P&L number for display with the spec's currency.
  // Examples:  USD 1234.5 → "$1,234.50"   NTD 12345 → "NT$12,345"
  //            JPY 1234   → "¥1,234"       EUR 1234.5 → "€1,234.50"
  // Falls back to "<code> <num>" for codes we don't have a symbol for.
  function formatMoney(amount, currency, opts = {}) {
    const cur = currency || 'USD';
    const sign = amount < 0 ? '-' : '';
    const abs = Math.abs(amount);
    const decimals = (opts.decimals != null) ? opts.decimals
                   : (cur === 'JPY' || cur === 'NTD' || cur === 'KRW') ? 0 : 2;
    const num = abs.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    const SYMBOLS = { USD: '$', NTD: 'NT$', EUR: '€', JPY: '¥', GBP: '£', HKD: 'HK$', CNY: '¥', AUD: 'A$', CAD: 'C$' };
    const sym = SYMBOLS[cur];
    return sym ? `${sign}${sym}${num}` : `${sign}${cur} ${num}`;
  }

  // ---------- Override layer ----------

  // Overrides applied so far (for reset/diff in the settings UI). Map of
  // base key (e.g. "TXF") → partial spec object.
  const OVERRIDES = {};

  /** Internal — apply a partial spec to the live map. Missing fields
   *  inherit from the built-in default for that symbol (or NQ defaults
   *  for symbols without a built-in entry). MUTATES the existing entry
   *  in place rather than replacing the object — SimEngine captures
   *  `spec` by closure (sim_engine.js create()), so a fresh object would
   *  leave the engine reading stale values. Mutation keeps the reference
   *  stable so any held copy sees the update. */
  function _applyOverride(baseKey, partial) {
    const base = BUILT_IN_SPECS[baseKey] || BUILT_IN_SPECS[DEFAULT_SYMBOL];
    const merged = { ...base, ...partial };
    if (SYMBOL_SPECS[baseKey]) {
      // Wipe stale keys not in `merged` (e.g. removed override fields)
      // before assigning so the live entry exactly mirrors the spec.
      for (const k of Object.keys(SYMBOL_SPECS[baseKey])) {
        if (!(k in merged)) delete SYMBOL_SPECS[baseKey][k];
      }
      Object.assign(SYMBOL_SPECS[baseKey], merged);
    } else {
      SYMBOL_SPECS[baseKey] = merged;
    }
  }

  /** Merge user-saved overrides on top of built-ins. Called once at
   *  boot from app.js. Silent on network failure — the built-ins are
   *  still usable, just without personalisation. */
  async function loadOverrides() {
    let body = null;
    try {
      const r = await fetch('/api/symbol-specs');
      if (!r.ok) return;
      body = await r.json();
    } catch (e) { return; }
    const ov = (body && body.overrides) || {};
    for (const [k, v] of Object.entries(ov)) {
      if (!v || typeof v !== 'object') continue;
      OVERRIDES[k] = { ...v };
      _applyOverride(k, v);
    }
    try {
      document.dispatchEvent(new CustomEvent('symbol_specs:changed', {
        detail: { changedKeys: Object.keys(ov) },
      }));
    } catch (e) { /* ignore */ }
  }

  /** Persist a per-symbol override and update the live map. Returns
   *  true on success. Re-fires symbol_specs:changed so panels refresh. */
  async function setOverride(baseKey, partial) {
    if (!baseKey) return false;
    const key = resolveBaseKey(baseKey);
    try {
      const r = await fetch(`/api/symbol-specs/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      if (!r.ok) return false;
    } catch (e) { return false; }
    OVERRIDES[key] = { ...partial };
    _applyOverride(key, partial);
    try {
      document.dispatchEvent(new CustomEvent('symbol_specs:changed', {
        detail: { changedKeys: [key] },
      }));
    } catch (e) { /* ignore */ }
    return true;
  }

  /** Drop an override and revert to the built-in default. */
  async function removeOverride(baseKey) {
    if (!baseKey) return false;
    const key = resolveBaseKey(baseKey);
    try {
      const r = await fetch(`/api/symbol-specs/${encodeURIComponent(key)}`, { method: 'DELETE' });
      if (!r.ok) return false;
    } catch (e) { return false; }
    delete OVERRIDES[key];
    if (BUILT_IN_SPECS[key]) {
      // Same in-place mutation rule as _applyOverride — preserves
      // any closure-held reference (e.g. SimEngine's captured spec).
      const base = BUILT_IN_SPECS[key];
      if (SYMBOL_SPECS[key]) {
        for (const k of Object.keys(SYMBOL_SPECS[key])) {
          if (!(k in base)) delete SYMBOL_SPECS[key][k];
        }
        Object.assign(SYMBOL_SPECS[key], base);
      } else {
        SYMBOL_SPECS[key] = { ...base };
      }
    } else {
      delete SYMBOL_SPECS[key];
    }
    try {
      document.dispatchEvent(new CustomEvent('symbol_specs:changed', {
        detail: { changedKeys: [key] },
      }));
    } catch (e) { /* ignore */ }
    return true;
  }

  /** True if the given base key currently has a user override. */
  function hasOverride(baseKey) {
    return !!OVERRIDES[resolveBaseKey(baseKey)];
  }

  /** Read-only accessor for the built-in default of a base key (used
   *  by the settings modal's "Reset to default" path so it can show
   *  the original values without a round-trip). */
  function getBuiltIn(baseKey) {
    return BUILT_IN_SPECS[resolveBaseKey(baseKey)] || null;
  }

  window.SymbolSpecs = {
    SYMBOL_SPECS,
    DEFAULT_SYMBOL,
    ALLOWED_CURRENCIES,
    getSpec,
    isKnownSymbol,
    unitLabel,
    resolveBaseKey,
    formatMoney,
    listSymbols: () => Object.keys(SYMBOL_SPECS),
    loadOverrides,
    setOverride,
    removeOverride,
    hasOverride,
    getBuiltIn,
  };
})();
