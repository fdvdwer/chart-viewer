/**
 * Acceptance test harness for position_calc.js.
 *
 * Run from chart_viewer/static/ with:
 *   node test_position_calc.js
 *
 * Verifies the 8 acceptance cases from docs/specs/position-tool-spec.md
 * plus the floor-vs-round stress case and the long/short symmetry test.
 *
 * Uses a tiny window shim so the IIFE-attached modules (which target the
 * browser) can run under Node.
 */

global.window = {};
require('./symbol_specs.js');
require('./position_calc.js');

const { getSpec } = global.window.SymbolSpecs;
const { calc } = global.window.PositionCalc;

const TESTS = [
  // The spec table — id matches table column 1 in docs/specs/position-tool-spec.md.
  { id: 1, sym: 'NQ',     acct: 50000, risk: 2, stop: 50,    expQty: 1,    expRisk: 1000 },
  { id: 2, sym: 'NQ',     acct: 40000, risk: 2, stop: 50,    expQty: 0,    expRisk: 0,    note: 'under-funded; need ≤40 pts' },
  { id: 3, sym: 'NQ',     acct: 60000, risk: 2, stop: 50,    expQty: 1,    expRisk: 1000, note: '1.67% actual' },
  { id: 4, sym: 'MNQ',    acct: 10000, risk: 2, stop: 57.75, expQty: 1,    expRisk: 115.5 },
  { id: 5, sym: 'ES',     acct: 25000, risk: 1, stop: 5,     expQty: 1,    expRisk: 250 },
  { id: 6, sym: 'GC',     acct: 50000, risk: 2, stop: 5,     expQty: 2,    expRisk: 1000 },
  { id: 7, sym: 'XAUUSD', acct: 10000, risk: 2, stop: 21.82, expQty: 0.09, expRisk: 196.38 },
  { id: 8, sym: 'XAUUSD', acct: 50000, risk: 2, stop: 50,    expQty: 0.20, expRisk: 1000 },
];

function runOne({ sym, acct, risk, stop, expQty, expRisk }) {
  const spec = getSpec(sym);
  const entry = 1000;
  const r = calc({
    entryPrice: entry,
    targetPrice: entry,           // target unused for risk math; pick any
    stopPrice: entry - stop,      // long: stop below entry
    spec,
    accountSize: acct,
    riskPercent: risk,
  });
  const qtyOK  = Math.abs(r.qty - expQty) < 1e-6;
  const riskOK = Math.abs(r.actualRiskUSD - expRisk) < 0.5;
  return { result: r, qtyOK, riskOK };
}

let pass = 0, fail = 0;
for (const t of TESTS) {
  const { result, qtyOK, riskOK } = runOne(t);
  const ok = qtyOK && riskOK;
  if (ok) pass++; else fail++;
  const qtyStr  = `qty=${result.qty} (exp ${t.expQty})`;
  const riskStr = `risk=$${result.actualRiskUSD.toFixed(2)} (exp $${t.expRisk})`;
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] #${t.id} ${t.sym.padEnd(7)} ` +
    `acct=${t.acct} risk=${t.risk}% stop=${t.stop}pts → ${qtyStr}  ${riskStr}` +
    (t.note ? `  (${t.note})` : '')
  );
}

// Floor-vs-round stress case from spec: NQ $35K / 2% / 50pt → RawQty=0.7
// floor → 0 (under-funded)  |  round → 1 (would silently exceed risk!)
console.log('\n--- Floor stress case (spec section "Floor verification stress case") ---');
{
  const spec = getSpec('NQ');
  const args = { entryPrice: 1000, targetPrice: 1000, stopPrice: 950,
                 spec, accountSize: 35000, riskPercent: 2 };
  const floored = calc({ ...args, roundingMode: 'floor' });
  const rounded = calc({ ...args, roundingMode: 'round' });
  const floorOK = floored.qty === 0;
  const roundOK = rounded.qty === 1;
  console.log(`[${floorOK ? 'PASS' : 'FAIL'}] floor mode  → qty=${floored.qty} (exp 0, under-funded)`);
  console.log(`[${roundOK ? 'PASS' : 'FAIL'}] round mode  → qty=${rounded.qty} (exp 1, would over-risk)`);
  if (floorOK) pass++; else fail++;
  if (roundOK) pass++; else fail++;
}

// Long / short symmetry: same prices flipped → same qty + same risk.
console.log('\n--- Long/short symmetry ---');
{
  const spec = getSpec('NQ');
  const longR = calc({
    entryPrice: 20000, targetPrice: 20100, stopPrice: 19950,
    spec, accountSize: 50000, riskPercent: 2,
  });
  const shortR = calc({
    entryPrice: 20000, targetPrice: 19900, stopPrice: 20050,
    spec, accountSize: 50000, riskPercent: 2,
  });
  const symOK = longR.qty === shortR.qty
              && Math.abs(longR.actualRiskUSD - shortR.actualRiskUSD) < 1e-9
              && Math.abs(longR.targetUSD - shortR.targetUSD) < 1e-9;
  console.log(`[${symOK ? 'PASS' : 'FAIL'}] long  qty=${longR.qty}  risk=$${longR.actualRiskUSD}  target=$${longR.targetUSD}`);
  console.log(`[${symOK ? 'PASS' : 'FAIL'}] short qty=${shortR.qty} risk=$${shortR.actualRiskUSD}  target=$${shortR.targetUSD}`);
  if (symOK) pass++; else fail++;
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
