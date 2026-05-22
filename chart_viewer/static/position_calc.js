/**
 * position_calc.js — Pure position-sizing math for the long/short tools.
 *
 * Implements the formulas from position-tool-spec.md:
 *
 *   RiskUSD     = AccountSize × RiskPercent / 100
 *   StopPoints  = abs(EntryPrice - StopPrice)
 *   RawQty      = RiskUSD / (StopPoints × PointValue × LotSize)
 *   Qty         = floor(RawQty / QtyStep) × QtyStep         (default rounding)
 *
 * **Floor (not round) is mandatory** — round would let users exceed declared
 * risk when RawQty falls in [0.5, 1.0). Floor guarantees actual risk never
 * exceeds the configured limit. The settings UI exposes a `round` mode for
 * the curious, but `floor` is the default and the tested path.
 *
 * **All USD figures use `Qty × Points × PointValue × LotSize`** — no
 * "if Qty=1" per-unit shortcuts. This is the bug we are explicitly avoiding.
 */
(function () {
  const SymbolSpecs = window.SymbolSpecs;

  /**
   * @param {object} args
   * @param {number} args.entryPrice
   * @param {number} args.targetPrice
   * @param {number} args.stopPrice
   * @param {object} args.spec       — output of SymbolSpecs.getSpec(symbol)
   * @param {number} args.accountSize
   * @param {number} args.riskPercent
   * @param {string} [args.roundingMode='floor']  'floor' | 'round'
   * @returns {object} { qty, rawQty, riskUSD, actualRiskUSD, actualRiskPct,
   *                     stopPoints, stopTicks, targetPoints, targetTicks,
   *                     stopPct, targetPct, stopUSD, targetUSD, rrRatio,
   *                     underFunded, maxStopForOneUnit }
   */
  function calc({
    entryPrice,
    targetPrice,
    stopPrice,
    spec,
    accountSize,
    riskPercent,
    roundingMode = 'floor',
  }) {
    if (!spec) throw new Error('position_calc: spec required');
    const { pointValue, lotSize, qtyStep, tickSize } = spec;

    const stopPoints   = Math.abs(entryPrice - stopPrice);
    const targetPoints = Math.abs(targetPrice - entryPrice);

    // Per-unit dollar risk for one full lot of `lotSize` units. We keep this
    // as a single named value because both the qty calc and the under-funded
    // helper text need it.
    const riskPerUnit = stopPoints * pointValue * lotSize;
    const riskUSD = (accountSize > 0 && riskPercent > 0)
      ? accountSize * riskPercent / 100
      : 0;

    let rawQty = 0;
    if (riskPerUnit > 0 && riskUSD > 0) {
      rawQty = riskUSD / riskPerUnit;
    }

    let qty;
    const step = qtyStep > 0 ? qtyStep : 1;
    if (roundingMode === 'round') {
      qty = Math.round(rawQty / step) * step;
    } else {
      qty = Math.floor(rawQty / step) * step;
    }
    // Floor / round can't yield negative qty in this formula, but guard
    // against floating-point noise just in case.
    if (qty < 0) qty = 0;
    // Re-snap to step precision (Math.floor on floats can leak 1e-15 dust).
    qty = roundQtyToStep(qty, step);

    const underFunded = qty <= 0;
    const maxStopForOneUnit = (pointValue > 0 && lotSize > 0 && riskUSD > 0)
      ? Math.floor(riskUSD / (pointValue * lotSize))
      : 0;

    // ALL P/L figures use Qty × Points × PointValue × LotSize. No per-unit
    // shortcuts (the spec calls this out as the bug we are avoiding).
    const stopUSD   = qty * stopPoints   * pointValue * lotSize;
    const targetUSD = qty * targetPoints * pointValue * lotSize;
    const actualRiskUSD = stopUSD;
    const actualRiskPct = (accountSize > 0)
      ? (actualRiskUSD / accountSize) * 100
      : 0;

    const stopPct   = entryPrice > 0 ? (stopPoints   / entryPrice) * 100 : 0;
    const targetPct = entryPrice > 0 ? (targetPoints / entryPrice) * 100 : 0;
    const rrRatio   = stopPoints > 0 ? (targetPoints / stopPoints) : 0;

    const stopTicks   = tickSize > 0 ? Math.round(stopPoints   / tickSize) : 0;
    const targetTicks = tickSize > 0 ? Math.round(targetPoints / tickSize) : 0;

    return {
      qty,
      rawQty,
      riskUSD,
      actualRiskUSD,
      actualRiskPct,
      stopPoints,
      stopTicks,
      stopPct,
      stopUSD,
      targetPoints,
      targetTicks,
      targetPct,
      targetUSD,
      rrRatio,
      underFunded,
      maxStopForOneUnit,
    };
  }

  /**
   * Snap qty to the precision of qtyStep — protects against floating-point
   * dust like 0.09000000000001 that would render badly.
   */
  function roundQtyToStep(qty, step) {
    if (step >= 1) return Math.round(qty);
    // Count decimals in step (e.g. 0.01 → 2)
    const s = String(step);
    const dot = s.indexOf('.');
    const decimals = dot < 0 ? 0 : (s.length - dot - 1);
    const mul = Math.pow(10, decimals);
    return Math.round(qty * mul) / mul;
  }

  /**
   * Format qty for display — futures show as integer, spot uses qty-step
   * precision (e.g. 0.09 with qtyStep 0.01).
   */
  function formatQty(qty, qtyStep) {
    if (qtyStep >= 1) return String(Math.round(qty));
    const s = String(qtyStep);
    const dot = s.indexOf('.');
    const decimals = dot < 0 ? 0 : (s.length - dot - 1);
    return Number(qty).toFixed(decimals);
  }

  function formatUSD(usd, decimals = 0) {
    if (!Number.isFinite(usd)) return '—';
    const n = Math.abs(usd).toFixed(decimals);
    return (usd < 0 ? '-$' : '$') + Number(n).toLocaleString('en-US', {
      maximumFractionDigits: decimals,
      minimumFractionDigits: 0,
    });
  }

  /**
   * Simplified calc — no SymbolSpecs dependency. The user supplies all
   * sizing params directly via the per-overlay settings panel:
   *
   *   AccountSize, LotSize (= contract multiplier in $/pt; user sets it),
   *   RiskPercent, Leverage (informational), TickSize (for label only),
   *   QtyPrecision ('default'|'integer'|'1'..'10' decimals).
   *
   *   RiskUSD     = AccountSize × RiskPercent / 100
   *   RawQty      = RiskUSD / (StopPoints × LotSize)
   *   Qty         = floor(RawQty / qtyStep) × qtyStep
   *   StopUSD     = Qty × StopPoints   × LotSize
   *   TargetUSD   = Qty × TargetPoints × LotSize
   *
   * Floor is mandatory (same reason as the original calc): round would let
   * actual risk silently exceed the configured limit.
   */
  function calcSimple({
    entryPrice, targetPrice, stopPrice,
    accountSize, lotSize, riskPercent,
    tickSize, qtyPrecision,
  }) {
    const lot   = lotSize > 0 ? lotSize : 1;
    const tick  = tickSize > 0 ? tickSize : 0.25;
    const stopPoints   = Math.abs(entryPrice - stopPrice);
    const targetPoints = Math.abs(targetPrice - entryPrice);
    const riskUSD = (accountSize > 0 && riskPercent > 0)
      ? accountSize * riskPercent / 100
      : 0;

    const riskPerLot = stopPoints * lot;
    let rawQty = (riskPerLot > 0 && riskUSD > 0) ? riskUSD / riskPerLot : 0;

    let qtyStep;
    if (qtyPrecision === 'integer' || qtyPrecision === 'default' || qtyPrecision == null) {
      qtyStep = 1;
    } else {
      const decimals = parseInt(qtyPrecision, 10);
      qtyStep = (Number.isFinite(decimals) && decimals > 0) ? Math.pow(10, -decimals) : 1;
    }
    let qty = Math.floor(rawQty / qtyStep) * qtyStep;
    if (qty < 0) qty = 0;
    qty = roundQtyToStep(qty, qtyStep);

    const stopUSD       = qty * stopPoints   * lot;
    const targetUSD     = qty * targetPoints * lot;
    const actualRiskUSD = stopUSD;
    const actualRiskPct = accountSize > 0 ? (actualRiskUSD / accountSize) * 100 : 0;

    const stopPct   = entryPrice > 0 ? (stopPoints   / entryPrice) * 100 : 0;
    const targetPct = entryPrice > 0 ? (targetPoints / entryPrice) * 100 : 0;
    const stopTicks   = tick > 0 ? Math.round(stopPoints   / tick) : 0;
    const targetTicks = tick > 0 ? Math.round(targetPoints / tick) : 0;
    const rrRatio = stopPoints > 0 ? targetPoints / stopPoints : 0;

    return {
      qty, qtyStep, rawQty, riskUSD, actualRiskUSD, actualRiskPct,
      stopPoints, stopTicks, stopPct, stopUSD,
      targetPoints, targetTicks, targetPct, targetUSD,
      rrRatio,
    };
  }

  window.PositionCalc = {
    calc,
    calcSimple,
    roundQtyToStep,
    formatQty,
    formatUSD,
  };
})();
