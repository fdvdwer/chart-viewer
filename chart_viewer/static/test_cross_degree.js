/* ============================================================================
 * test_cross_degree.js — Phase 4b sanity tests (fan-out, nesting, no-lookahead)
 * ============================================================================
 * Run with:  node static/test_cross_degree.js
 * ========================================================================== */

global.window = { addEventListener: () => {}, dispatchEvent: () => {} };
require('./indicators/n_wave.js');
require('./indicators/bos_choch.js');
require('./indicators/supply_demand_zones.js');
const CD = require('./cross_degree.js');
const D = global.window.BOSChoChDetector;

let _t = 0, _f = 0;
function test(name, fn) {
  _t++;
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { _f++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, e, m) {
  const aS = JSON.stringify(a), eS = JSON.stringify(e);
  if (aS !== eS) throw new Error(`${m || 'assertEq'} — expected ${eS}, got ${aS}`);
}

const TS0 = 1700000000000;
const TF_MS = 300000;  // 5min

// Fixture builder (same shape as test_supply_demand_zones.js)
function buildScenario({ pivots, length, overrides }) {
  const sorted = [...pivots].sort((a, b) => a.barIdx - b.barIdx);
  const bars = [];
  const basePrice = sorted.length ? sorted[0].price : 100;
  for (let i = 0; i < length; i++) {
    bars.push({ timestamp: TS0 + i * TF_MS, open: basePrice, high: basePrice, low: basePrice, close: basePrice, volume: 0 });
  }
  if (sorted.length) {
    const first = sorted[0];
    for (let i = 0; i < first.barIdx; i++) { bars[i].open = bars[i].close = bars[i].high = bars[i].low = first.price; }
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    for (let k = a.barIdx + 1; k < b.barIdx; k++) {
      const t = (k - a.barIdx) / (b.barIdx - a.barIdx);
      const v = a.price + (b.price - a.price) * t;
      bars[k].open = bars[k].close = bars[k].high = bars[k].low = v;
    }
  }
  if (sorted.length) {
    const last = sorted[sorted.length - 1];
    const v = last.type === 'high' ? last.price - 1 : last.price + 1;
    for (let i = last.barIdx + 1; i < length; i++) { bars[i].open = bars[i].close = bars[i].high = bars[i].low = v; }
  }
  for (const pp of sorted) {
    const b = bars[pp.barIdx];
    if (pp.type === 'high') { b.high = pp.price; b.open = b.close = b.low = pp.price - 1; }
    else { b.low = pp.price; b.open = b.close = b.high = pp.price + 1; }
  }
  if (overrides) for (const k of Object.keys(overrides)) {
    const o = overrides[k], b = bars[Number(k)];
    if (o.open !== undefined) b.open = o.open;
    if (o.high !== undefined) b.high = o.high;
    if (o.low !== undefined) b.low = o.low;
    if (o.close !== undefined) b.close = o.close;
  }
  return bars;
}

function bosUpBars() {
  // BOS up: breaks H@b7(115) at b11.
  return buildScenario({
    length: 16,
    pivots: [
      { barIdx: 1, type: 'low', price: 95 },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low', price: 98 },
      { barIdx: 7, type: 'high', price: 115 },
      { barIdx: 9, type: 'low', price: 104 },
    ],
    overrides: { 11: { open: 110, high: 118, low: 110, close: 117 } },
  });
}

console.log('\n=== Cross-Degree (Phase 4b) ===');

// ----------------------------------------------------------------------------
// 1. Fan-out parity: a degree's events match a direct single-TF detector run.
// ----------------------------------------------------------------------------
test('fan-out parity: degree events == direct detectEventsFromSeq', () => {
  const bars = bosUpBars();
  const params = { degrees: ['5'], left_strength: 1, right_strength: 1, min_swing_amount: 0 };
  const snap = CD.buildSnapshot({ '5': bars }, null, params);
  const direct = D.detectEventsFromSeq(
    window.NWaveIndicator.applyAmplitudeFilter(window.NWaveIndicator.detectAlternatingSequence(bars, 1, 1), 0, 'absolute'),
    bars, { ...D.defaultParams, left_strength: 1, right_strength: 1, min_swing_amount: 0 }
  );
  assertEq(snap.degrees.length, 1);
  assertEq(snap.degrees[0].events.map(e => e.id),
           direct.map(e => `${e.type}_${e.direction}_${e.eventBarIdx}`),
           'event ids match direct run');
  assert(snap.degrees[0].events.length > 0, 'at least one event');
});

// ----------------------------------------------------------------------------
// 2. No-lookahead: asof excludes future events; monotonic prefix as asof grows.
// ----------------------------------------------------------------------------
test('no-lookahead: asof truncates future events + monotonic prefix', () => {
  const bars = bosUpBars();
  const params = { degrees: ['5'], min_swing_amount: 0 };
  const full = CD.buildSnapshot({ '5': bars }, null, params).degrees[0].events;
  assert(full.length > 0, 'full run has events');

  // asof BEFORE the last event → that event must be absent.
  const lastEv = full[full.length - 1];
  const asofBefore = lastEv.eventTs - 1;
  const early = CD.buildSnapshot({ '5': bars }, asofBefore, params).degrees[0].events;
  assert(!early.some(e => e.id === lastEv.id), 'future event excluded at earlier asof');

  // Monotonic prefix: earlier event set ⊆ later event set (by id).
  const earlyIds = new Set(early.map(e => e.id));
  const laterIds = new Set(full.map(e => e.id));
  for (const id of earlyIds) assert(laterIds.has(id), `prefix property: ${id} should persist`);
});

// ----------------------------------------------------------------------------
// 3. Nesting: inside_zone when a child event level sits inside a parent zone.
// ----------------------------------------------------------------------------
function degree(id, tf, events, zones) {
  return { id, tf, trend: 'up', pivots: [], events, zones };
}
function ev(id, dir, level, ts, type) { return { id, type: type || 'CHoCh', direction: dir, level, eventTs: ts, pivotTs: ts, obTs: ts, obPrice: level }; }
function zone(id, side, lower, upper, status, xFromTs, xToTs, eventTs) {
  return { id, side, lower, upper, extreme: side === 'demand' ? lower : upper, xFromTs, xToTs, status, eventTs, triggeredBy: id };
}

test('nesting: child event inside parent zone → inside_zone', () => {
  const child = degree('d0', '1', [ev('c1', 'up', 95, 5000)], []);
  const parent = degree('d2', '15', [], [zone('p1', 'demand', 90, 100, 'tested', 1000, 9000, 1000)]);
  const { relations } = CD.computeNesting([child, parent], {});
  const r = relations.find(x => x.relation === 'inside_zone');
  assert(r, `inside_zone emitted; got ${relations.map(x => x.relation).join(',')}`);
  assertEq(r.child.id, 'c1'); assertEq(r.parent.id, 'p1');
});

// ----------------------------------------------------------------------------
// 4. Nesting: aligned when child level ~ a parent zone edge (within tol).
// ----------------------------------------------------------------------------
test('nesting: child level near parent zone edge → aligned', () => {
  const child = degree('d0', '1', [ev('c1', 'down', 100.4, 5000)], []);  // ~ parent upper 100
  const parent = degree('d2', '15', [], [zone('p1', 'supply', 90, 100, 'untested', 1000, 9000, 1000)]);
  const { relations } = CD.computeNesting([child, parent], { align_tol_ticks: 1, tick_size: 1 });
  assert(relations.some(r => r.relation === 'aligned'), 'aligned emitted');
});

// ----------------------------------------------------------------------------
// 5. Nesting direction: only small → large (Q4), never large → small.
// ----------------------------------------------------------------------------
test('nesting: only emitted child(small) → parent(large)', () => {
  const small = degree('d0', '1', [ev('c1', 'up', 95, 5000)], []);
  const large = degree('d2', '15', [], [zone('p1', 'demand', 90, 100, 'tested', 1000, 9000, 1000)]);
  const { relations } = CD.computeNesting([large, small], {});  // pass in any order
  for (const r of relations) {
    assert(CD._tfRank(r.child.tf) < CD._tfRank(r.parent.tf), 'child TF strictly smaller than parent');
  }
});

// ----------------------------------------------------------------------------
// 6. above_untested: child reacts above an untested parent zone, after it formed.
// ----------------------------------------------------------------------------
test('nesting: child above an untested parent zone → above_untested', () => {
  const child = degree('d0', '1', [ev('c1', 'up', 130, 5000)], []);   // above upper 100, after eventTs 1000
  const parent = degree('d2', '15', [], [zone('p1', 'demand', 90, 100, 'untested', 1000, 3000, 1000)]);
  const { relations } = CD.computeNesting([child, parent], {});
  assert(relations.some(r => r.relation === 'above_untested'), 'above_untested emitted');
});

// ----------------------------------------------------------------------------
// 7. reversal/force-zone: K consecutive same-dir child CHoCh above an untested
//    parent zone → one reversalZone flag (§2.3.1 / §721).
// ----------------------------------------------------------------------------
test('reversal zone: 3 consecutive 1min CHoCh-up above an untested zone', () => {
  const child = degree('d0', '1', [
    ev('c1', 'up', 130, 2000), ev('c2', 'up', 132, 3000), ev('c3', 'up', 134, 4000),
  ], [zone('z1', 'demand', 125, 131, 'untested', 2500, 4500, 2000)]);
  const parent = degree('d2', '15', [], [zone('p1', 'demand', 90, 100, 'untested', 1000, 1500, 1000)]);
  const { reversalZones } = CD.computeNesting([child, parent], { reversal_choch_run: 3 });
  assertEq(reversalZones.length, 1, 'one reversal zone');
  const rz = reversalZones[0];
  assertEq(rz.side, 'above'); assertEq(rz.direction, 'up');
  assertEq(rz.chochRun, ['c1', 'c2', 'c3']);
  assertEq(rz.nearestZoneId, 'z1');
});

// ----------------------------------------------------------------------------
// 8. reversal zone: a TESTED parent zone produces no flag.
// ----------------------------------------------------------------------------
test('reversal zone: tested parent zone → no flag', () => {
  const child = degree('d0', '1', [
    ev('c1', 'up', 130, 2000), ev('c2', 'up', 132, 3000), ev('c3', 'up', 134, 4000),
  ], []);
  const parent = degree('d2', '15', [], [zone('p1', 'demand', 90, 100, 'tested', 1000, 1500, 1000)]);
  const { reversalZones } = CD.computeNesting([child, parent], { reversal_choch_run: 3 });
  assertEq(reversalZones.length, 0, 'no reversal zone for tested parent');
});

// ----------------------------------------------------------------------------
// 9. reversal zone: only 2 CHoCh (< K) → no flag.
// ----------------------------------------------------------------------------
test('reversal zone: fewer than K consecutive CHoCh → no flag', () => {
  const child = degree('d0', '1', [ev('c1', 'up', 130, 2000), ev('c2', 'up', 132, 3000)], []);
  const parent = degree('d2', '15', [], [zone('p1', 'demand', 90, 100, 'untested', 1000, 1500, 1000)]);
  const { reversalZones } = CD.computeNesting([child, parent], { reversal_choch_run: 3 });
  assertEq(reversalZones.length, 0, 'no flag below K');
});

// ----------------------------------------------------------------------------
// 10. End-to-end buildSnapshot shape (two real degrees from the same fixture).
// ----------------------------------------------------------------------------
test('buildSnapshot: shape + asof + small→large ordering', () => {
  const bars = bosUpBars();
  const snap = CD.buildSnapshot({ '1': bars, '5': bars }, null, { degrees: ['1', '5'], min_swing_amount: 0 });
  assertEq(snap.schemaVersion, 1);
  assertEq(snap.degrees.map(d => d.tf), ['1', '5']);
  assert(Array.isArray(snap.nesting), 'nesting array present');
  assert(Array.isArray(snap.reversalZones), 'reversalZones array present');
  for (const r of snap.nesting) {
    assert(CD._tfRank(r.child.tf) < CD._tfRank(r.parent.tf), 'small→large only');
  }
});

console.log(`\n=== Result: ${_t - _f}/${_t} passed ===\n`);
if (_f > 0) process.exit(1);
