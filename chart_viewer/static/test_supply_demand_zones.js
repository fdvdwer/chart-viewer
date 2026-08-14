/* ============================================================================
 * test_supply_demand_zones.js — Sanity tests for Phase 4 zone framing.
 * ============================================================================
 * Run with:  node static/test_supply_demand_zones.js
 *
 * Tests cover: zone framing geometry (Q1 force point heuristic + Q2 wick
 * bounds), zone classification (supply vs demand), lifecycle state machine
 * (untested → tested → invalidated). Uses the same buildScenario fixture
 * helper as test_bos_choch.js to construct consistent bar data.
 * ========================================================================== */

global.window = { addEventListener: () => {}, dispatchEvent: () => {} };
require('./indicators/n_wave.js');
require('./indicators/bos_choch.js');
require('./indicators/supply_demand_zones.js');

const Z = global.window.SupplyDemandZones;
const D = global.window.BOSChoChDetector;
if (!Z || !D) {
  console.error('FAIL: indicator modules not loaded');
  process.exit(1);
}

const DEFAULTS = Z.defaultParams;
const TS0 = 1700000000000;
const TF_MS = 300000;

let _testCount = 0;
let _failCount = 0;

function test(name, fn) {
  _testCount++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    _failCount++;
    console.error(`  ✗ ${name}`);
    console.error(`      ${e.message}`);
    if (e.stack) console.error(`      ${e.stack.split('\n').slice(1, 4).join('\n      ')}`);
  }
}

function assertEq(a, e, msg) {
  const aS = JSON.stringify(a);
  const eS = JSON.stringify(e);
  if (aS !== eS) throw new Error(`${msg || 'assertEq'} — expected ${eS}, got ${aS}`);
}
function assertNear(a, e, eps, msg) {
  if (Math.abs(a - e) > eps) throw new Error(`${msg || 'assertNear'} — expected ${e}±${eps}, got ${a}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ---- Fixture builder (copied from test_bos_choch.js) -------------------------

function buildScenario({ pivots, length, overrides }) {
  const sorted = [...pivots].sort((a, b) => a.barIdx - b.barIdx);
  const bars = [];
  const basePrice = sorted.length > 0 ? sorted[0].price : 100;
  for (let i = 0; i < length; i++) {
    bars.push({
      timestamp: TS0 + i * TF_MS,
      open: basePrice, high: basePrice, low: basePrice, close: basePrice,
      volume: 0,
    });
  }
  if (sorted.length > 0) {
    const first = sorted[0];
    for (let i = 0; i < first.barIdx; i++) {
      bars[i].open = first.price; bars[i].close = first.price;
      bars[i].high = first.price; bars[i].low = first.price;
    }
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    for (let k = a.barIdx + 1; k < b.barIdx; k++) {
      const t = (k - a.barIdx) / (b.barIdx - a.barIdx);
      const v = a.price + (b.price - a.price) * t;
      bars[k].open = v; bars[k].close = v;
      bars[k].high = v; bars[k].low = v;
    }
  }
  if (sorted.length > 0) {
    const last = sorted[sorted.length - 1];
    const v = last.type === 'high' ? last.price - 1 : last.price + 1;
    for (let i = last.barIdx + 1; i < length; i++) {
      bars[i].open = v; bars[i].close = v;
      bars[i].high = v; bars[i].low = v;
    }
  }
  for (const p of sorted) {
    const b = bars[p.barIdx];
    if (p.type === 'high') {
      b.high = p.price; b.open = p.price - 1; b.close = p.price - 1; b.low = p.price - 1;
    } else {
      b.low = p.price; b.open = p.price + 1; b.close = p.price + 1; b.high = p.price + 1;
    }
  }
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      const o = overrides[k];
      const b = bars[Number(k)];
      if (o.open  !== undefined) b.open  = o.open;
      if (o.high  !== undefined) b.high  = o.high;
      if (o.low   !== undefined) b.low   = o.low;
      if (o.close !== undefined) b.close = o.close;
    }
  }
  const seq = sorted.map(p => ({
    barIdx: p.barIdx, type: p.type, price: p.price,
    ts: TS0 + p.barIdx * TF_MS,
  }));
  return { bars, seq };
}

function withDefaults(o) { return { ...DEFAULTS, ...o }; }

// ============================================================================
//  SCENARIOS
// ============================================================================

console.log('\n=== Supply / Demand Zones ===');

// ----------------------------------------------------------------------------
// Setup: standard up-trend then CHoCh down setup (reuse bos_choch test 3)
// This creates a CHoCh down event we can frame a SUPPLY zone around.
// ----------------------------------------------------------------------------
function bearishChochSetup() {
  return buildScenario({
    length: 14,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low',  price: 98  },
      { barIdx: 7, type: 'high', price: 115 },
      { barIdx: 9, type: 'low',  price: 104 },
    ],
    overrides: {
      10: { open: 105, high: 105, low: 99, close: 100 },   // CHoCh down: breaks L3=104
    },
  });
}

// ----------------------------------------------------------------------------
// 1. CHoCh down creates a SUPPLY zone with correct origin/force/extreme
// ----------------------------------------------------------------------------
test('CHoCh down creates SUPPLY zone with origin = prev swing high (H2=115)', () => {
  const { bars, seq } = bearishChochSetup();
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  assertEq(events.length, 1, 'CHoCh event should fire');
  assertEq(events[0].type, 'CHoCh');
  assertEq(events[0].direction, 'down');

  const zones = Z.detectZones(events, seq, bars, withDefaults({ right_strength: 1 }));
  assertEq(zones.length, 1, 'one zone framed');
  const z = zones[0];
  assertEq(z.side, 'supply', 'CHoCh down → supply zone');
  // origin = the pivot BEFORE the broken pivot (L3@b9). Previous pivot is H2@b7.
  assertEq(z.origin.barIdx, 7);
  assertEq(z.origin.price, 115);
});

// ----------------------------------------------------------------------------
// 2. Zone bounds = wick (Q2 default): top = highest wick, bottom = lowest wick
// ----------------------------------------------------------------------------
test('zone_bounds=wick uses highest high / lowest low of the X-range', () => {
  const { bars, seq } = bearishChochSetup();
  // The X-range will be [origin.barIdx=7, force.barIdx]. We don't control
  // force.barIdx exactly (it's heuristic), so just verify the bounds are
  // INSIDE the wick range of the bars from origin onwards.
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  const zones = Z.detectZones(events, seq, bars, withDefaults({ right_strength: 1, zone_bounds: 'wick' }));
  const z = zones[0];
  assert(z.bounds.upper >= z.bounds.lower, 'upper >= lower');
  // For a supply zone built around H2=115, upper should be at or above 115
  assert(z.bounds.upper >= 115 - 1, `supply upper should reach H2 area, got ${z.bounds.upper}`);
  // Extreme (SL placement reference) = wick high for supply
  assertEq(z.bounds.extreme, z.bounds.upper, 'supply extreme = upper wick (for wick mode)');
});

// ----------------------------------------------------------------------------
// 3. Mirror: CHoCh up creates DEMAND zone
// ----------------------------------------------------------------------------
test('CHoCh up creates DEMAND zone with origin = prev swing low', () => {
  const { bars, seq } = buildScenario({
    length: 12,
    pivots: [
      { barIdx: 1, type: 'high', price: 110 },
      { barIdx: 3, type: 'low',  price: 95  },
      { barIdx: 5, type: 'high', price: 103 },
      { barIdx: 7, type: 'low',  price: 92  },
      { barIdx: 9, type: 'high', price: 98  },
    ],
    overrides: {
      10: { open: 96, high: 103, low: 96, close: 102 },   // CHoCh up: breaks H3=98
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  assertEq(events[0].type, 'CHoCh');
  assertEq(events[0].direction, 'up');

  const zones = Z.detectZones(events, seq, bars, withDefaults({ right_strength: 1 }));
  assertEq(zones.length, 1);
  const z = zones[0];
  assertEq(z.side, 'demand');
  assertEq(z.origin.barIdx, 7);
  assertEq(z.origin.price, 92);
  // Extreme for demand = wick low
  assertEq(z.bounds.extreme, z.bounds.lower);
});

// ----------------------------------------------------------------------------
// 4. emit_bos_zones toggle: BOS events filter in/out
// ----------------------------------------------------------------------------
test('emit_bos_zones=false drops BOS events from zone list', () => {
  // BOS up scenario (from bos_choch test 1)
  const { bars, seq } = buildScenario({
    length: 14,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low',  price: 98  },
      { barIdx: 7, type: 'high', price: 115 },
      { barIdx: 9, type: 'low',  price: 104 },
    ],
    overrides: { 11: { open: 110, high: 118, low: 110, close: 117 } },
  });
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  assertEq(events[0].type, 'BOS');

  // With emit_bos_zones true (default): one zone
  const z1 = Z.detectZones(events, seq, bars, withDefaults({ right_strength: 1, emit_bos_zones: true }));
  assertEq(z1.length, 1);

  // With false: skipped
  const z2 = Z.detectZones(events, seq, bars, withDefaults({ right_strength: 1, emit_bos_zones: false }));
  assertEq(z2.length, 0);
});

// ----------------------------------------------------------------------------
// 5. Lifecycle: untested → tested → invalidated
// ----------------------------------------------------------------------------
test('lifecycle: zone progresses untested → tested → invalidated', () => {
  // Build a SUPPLY zone setup, then add bars AFTER the event:
  //   bar 11: still well below zone → untested
  //   bar 12: high touches zone area → tested
  //   bar 13: close blasts above the extreme → invalidated
  const { bars, seq } = buildScenario({
    length: 16,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low',  price: 98  },
      { barIdx: 7, type: 'high', price: 115 },
      { barIdx: 9, type: 'low',  price: 104 },
    ],
    overrides: {
      10: { open: 105, high: 105, low: 99, close: 100 },    // CHoCh down break
      11: { open: 100, high: 102, low: 99, close: 101 },    // drift, well below supply
      12: { open: 101, high: 113, low: 101, close: 112 },   // wick into supply zone
      13: { open: 112, high: 125, low: 112, close: 124 },   // close way above 115 → invalidated
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  const zones = Z.detectZones(events, seq, bars, withDefaults({ right_strength: 1, test_threshold_pct: 50, sweep_threshold_pct: 50 }));
  // NOTE: bar 13's huge upside move (close 124) BOTH invalidates the supply
  // zone AND triggers a new CHoCh up event (breaks swingHigh=115 since H2
  // was never previously broken). So we may see 1 supply + 1 demand zone
  // depending on state machine timing. The lifecycle assertion is on the
  // SUPPLY zone specifically — the demand zone fires AT bar 13 too so
  // it's harmless additional output.
  const z = zones.find(x => x.side === 'supply');
  assert(z, `supply zone should be framed; got zones: ${zones.map(x => x.side).join(',')}`);
  assert(z.testedAtBarIdx != null, `supply zone should be tested, status=${z.status}`);
  assert(z.testedAtBarIdx >= 11 && z.testedAtBarIdx <= 13, `tested at bar 11-13, got ${z.testedAtBarIdx}`);
  assertEq(z.status, 'invalidated');
  assert(z.sweptAtBarIdx >= 12, `swept at bar 12+, got ${z.sweptAtBarIdx}`);
});

// ----------------------------------------------------------------------------
// 6. Lifecycle: zone stays untested if price never returns
// ----------------------------------------------------------------------------
test('lifecycle: zone stays untested when price drifts away forever', () => {
  // After the CHoCh, price keeps making lower lows — never returns to supply.
  const { bars, seq } = buildScenario({
    length: 16,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low',  price: 98  },
      { barIdx: 7, type: 'high', price: 115 },
      { barIdx: 9, type: 'low',  price: 104 },
    ],
    overrides: {
      10: { open: 105, high: 105, low: 99, close: 100 },
      11: { open: 100, high: 100, low: 92, close: 93 },
      12: { open: 93, high: 93, low: 85, close: 86 },
      13: { open: 86, high: 86, low: 80, close: 81 },
      14: { open: 81, high: 81, low: 75, close: 76 },
      15: { open: 76, high: 76, low: 70, close: 71 },
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  const zones = Z.detectZones(events, seq, bars, withDefaults({ right_strength: 1 }));
  assertEq(zones[0].status, 'untested');
  assertEq(zones[0].testedAtBarIdx, null);
  assertEq(zones[0].sweptAtBarIdx, null);
});

// ----------------------------------------------------------------------------
// 7. Lifecycle: invalidated without ever being tested (gap-up close past extreme)
// ----------------------------------------------------------------------------
test('lifecycle: invalidated without tested (gap close past extreme)', () => {
  const { bars, seq } = buildScenario({
    length: 14,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low',  price: 98  },
      { barIdx: 7, type: 'high', price: 115 },
      { barIdx: 9, type: 'low',  price: 104 },
    ],
    overrides: {
      10: { open: 105, high: 105, low: 99, close: 100 },
      11: { open: 100, high: 130, low: 100, close: 130 },   // single huge bar straight through
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  const zones = Z.detectZones(events, seq, bars, withDefaults({ right_strength: 1, sweep_threshold_pct: 50 }));
  assertEq(zones[0].status, 'invalidated');
  // With a single bar punching through, tested may or may not fire first
  // depending on whether the close-beyond-extreme check runs after the
  // test check. Per current impl order: test check fires first → tested
  // set; then sweep check fires → invalidated. Both transitions happen
  // on bar 11.
  assert(zones[0].sweptAtBarIdx === 11, `swept at b11, got ${zones[0].sweptAtBarIdx}`);
});

// ----------------------------------------------------------------------------
// 8. base framing: the 發力/base anchor sits in [origin, event], and the
//    supply zone's near edge (lower) stays ABOVE the broken low — i.e. the
//    zone hugs the top base, it doesn't smear down across the leg.
// ----------------------------------------------------------------------------
test('base framing: supply zone anchored at top base, lower stays above broken low', () => {
  const { bars, seq } = buildScenario({
    length: 14,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low',  price: 98  },
      { barIdx: 7, type: 'high', price: 115 },
      { barIdx: 9, type: 'low',  price: 104 },
    ],
    overrides: {
      8: { open: 110, high: 112, low: 108, close: 111 },
      10: { open: 105, high: 105, low: 99, close: 100 },   // CHoCh down break of L=104
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  const zones = Z.detectZones(events, seq, bars, withDefaults({ right_strength: 1 }));
  const z = zones.find(x => x.side === 'supply');
  assert(z, 'supply zone exists');
  // base anchor lands in [origin, event]
  assert(z.force.barIdx >= z.origin.barIdx && z.force.barIdx <= z.triggeredBy.eventBarIdx,
    `base in [origin, event], got ${z.force.barIdx}`);
  // INVARIANT: a supply zone reverses a move DOWN through `level`, so its
  // body must sit entirely ABOVE that broken low.
  assert(z.bounds.lower > z.triggeredBy.level,
    `supply lower (${z.bounds.lower}) must stay above broken low (${z.triggeredBy.level})`);
});

// ----------------------------------------------------------------------------
// 8b. REGRESSION (user report 2026-05): a DEMAND zone must NEVER be drawn
//     ABOVE the bull BOS that created it. Steep leg with a mid-leg DOWN
//     pullback high up the leg — the old "largest opposite body" heuristic
//     anchored the zone there and the wick Y-bounds reached the broken-high
//     level. New midline base-framing keeps the zone in the origin half.
// ----------------------------------------------------------------------------
test('regression: demand zone top stays below its bull BOS break level', () => {
  const { bars, seq } = buildScenario({
    length: 16,
    pivots: [
      { barIdx: 1, type: 'low',  price: 100 },
      { barIdx: 3, type: 'high', price: 112 },
      { barIdx: 5, type: 'low',  price: 103 },   // origin of the b10 break
      { barIdx: 7, type: 'high', price: 118 },   // becomes the broken high
      { barIdx: 9, type: 'low',  price: 110 },
    ],
    overrides: {
      6:  { open: 104, high: 106, low: 103, close: 105 },  // real base near origin
      8:  { open: 117, high: 117, low: 111, close: 112 },  // mid-leg DOWN pullback, HIGH up
      10: { open: 112, high: 124, low: 112, close: 123 },  // BOS up: breaks 118
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  const zones = Z.detectZones(events, seq, bars, withDefaults({ right_strength: 1 }));
  const demand = zones.filter(z => z.side === 'demand');
  assert(demand.length > 0, 'at least one demand zone framed');
  for (const z of demand) {
    assert(z.bounds.upper < z.triggeredBy.level,
      `demand upper (${z.bounds.upper}) must stay below broken high (${z.triggeredBy.level}) ` +
      `[zone @origin ${z.origin.barIdx}, event ${z.triggeredBy.eventBarIdx}]`);
  }
});

// ----------------------------------------------------------------------------
// 9. Expiration: untested zone past max_untested_age_bars → expired
// ----------------------------------------------------------------------------
test('expiration: untested zone older than max_untested_age_bars → expired', () => {
  // Build a CHoCh down setup, then add MANY bars where price stays well
  // below the supply zone (never tested), more than max_untested_age_bars
  // bars after the event.
  const totalLen = 60;   // event at b10, so age = ~50 bars at end
  const overrides = {};
  overrides[10] = { open: 105, high: 105, low: 99, close: 100 };  // event bar
  for (let i = 11; i < totalLen; i++) {
    overrides[i] = { open: 90, high: 92, low: 88, close: 90 };    // way below zone
  }
  const { bars, seq } = buildScenario({
    length: totalLen,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low',  price: 98  },
      { barIdx: 7, type: 'high', price: 115 },
      { barIdx: 9, type: 'low',  price: 104 },
    ],
    overrides,
  });
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  const zones = Z.detectZones(events, seq, bars, withDefaults({
    right_strength: 1,
    auto_expire_untested: true,
    max_untested_age_bars: 30,
  }));
  const z = zones.find(x => x.side === 'supply');
  assert(z, 'supply zone should exist');
  assertEq(z.status, 'expired');
  assert(z.expiredAtBarIdx === 10 + 30, `expiredAt should be eventBar + max_age = 40, got ${z.expiredAtBarIdx}`);
});

// ----------------------------------------------------------------------------
// 10. Expiration toggle: auto_expire_untested=false keeps zone alive
// ----------------------------------------------------------------------------
test('expiration toggle: auto_expire_untested=false keeps zone untested', () => {
  const totalLen = 60;
  const overrides = {};
  overrides[10] = { open: 105, high: 105, low: 99, close: 100 };
  for (let i = 11; i < totalLen; i++) {
    overrides[i] = { open: 90, high: 92, low: 88, close: 90 };
  }
  const { bars, seq } = buildScenario({
    length: totalLen,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low',  price: 98  },
      { barIdx: 7, type: 'high', price: 115 },
      { barIdx: 9, type: 'low',  price: 104 },
    ],
    overrides,
  });
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  const zones = Z.detectZones(events, seq, bars, withDefaults({
    right_strength: 1,
    auto_expire_untested: false,    // toggle off
  }));
  const z = zones.find(x => x.side === 'supply');
  assertEq(z.status, 'untested');
  assert(z.expiredAtBarIdx == null, 'no expiredAtBarIdx when toggle off');
});

// ----------------------------------------------------------------------------
// 11. REGRESSION (user report 2026-05): entering replay must not make zones
//     vanish. Replay appends ~(remaining + 100) synthetic placeholder bars;
//     the age-expiration math must anchor to the last REAL bar, otherwise a
//     fresh untested zone trips max_untested_age_bars and gets hidden.
// ----------------------------------------------------------------------------
test('replay: placeholder bars do not falsely expire a young untested zone', () => {
  const overrides = { 10: { open: 105, high: 105, low: 99, close: 100 } };  // CHoCh down
  // a few REAL bars after the event, price stays well below the supply zone
  for (let i = 11; i < 16; i++) overrides[i] = { open: 90, high: 92, low: 88, close: 90 };
  const { bars, seq } = buildScenario({
    length: 16,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low',  price: 98  },
      { barIdx: 7, type: 'high', price: 115 },
      { barIdx: 9, type: 'low',  price: 104 },
    ],
    overrides,
  });
  // Simulate replay: append 200 placeholder bars past the last real bar.
  const fill = bars[15].close;
  for (let i = 0; i < 200; i++) {
    bars.push({ timestamp: TS0 + (16 + i) * TF_MS, open: fill, high: fill, low: fill, close: fill, volume: 0, _placeholder: true });
  }
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  const zones = Z.detectZones(events, seq, bars, withDefaults({
    right_strength: 1,
    auto_expire_untested: true,
    max_untested_age_bars: 30,   // real age (~5 bars) << 30, so must NOT expire
  }));
  const z = zones.find(x => x.side === 'supply');
  assert(z, 'supply zone should exist');
  assertEq(z.status, 'untested');                      // not falsely 'expired'
  assert(z.activeRightEdge === 15, `right edge at last real bar (15), got ${z.activeRightEdge}`);
});

// ----------------------------------------------------------------------------
// 12. attach_to_break render: the structure-facing edge snaps to the broken
//     level line (demand top → broken high, supply bottom → broken low).
// ----------------------------------------------------------------------------
test('attach_to_break: demand render-top snaps to broken high, supply bottom to broken low', () => {
  // Demand (CHoCh up) — reuse test 3 setup
  const demandFix = buildScenario({
    length: 12,
    pivots: [
      { barIdx: 1, type: 'high', price: 110 },
      { barIdx: 3, type: 'low',  price: 95  },
      { barIdx: 5, type: 'high', price: 103 },
      { barIdx: 7, type: 'low',  price: 92  },
      { barIdx: 9, type: 'high', price: 98  },
    ],
    overrides: { 10: { open: 96, high: 103, low: 96, close: 102 } },
  });
  const dEvents = D.detectEventsFromSeq(demandFix.seq, demandFix.bars, { ...D.defaultParams, right_strength: 1 });
  const dz = Z.detectZones(dEvents, demandFix.seq, demandFix.bars, withDefaults({ right_strength: 1 }))[0];
  // attach on (default): demand render-upper == broken high (event.level)
  const onD = Z._zoneRenderBounds(dz, { attach_to_break: true });
  assertEq(onD.upper, dz.triggeredBy.level, 'demand render-upper snaps to broken high');
  assert(onD.lower === dz.bounds.lower, 'demand render-lower stays at base low');
  // attach off: falls back to structural base bounds
  const offD = Z._zoneRenderBounds(dz, { attach_to_break: false });
  assertEq(offD.upper, dz.bounds.upper, 'attach off → base upper');

  // Supply (CHoCh down): bottom snaps to broken low
  const supplyFix = bearishChochSetup();
  const sEvents = D.detectEventsFromSeq(supplyFix.seq, supplyFix.bars, { ...D.defaultParams, right_strength: 1 });
  const sz = Z.detectZones(sEvents, supplyFix.seq, supplyFix.bars, withDefaults({ right_strength: 1 }))
    .find(z => z.side === 'supply');
  const onS = Z._zoneRenderBounds(sz, { attach_to_break: true });
  assertEq(onS.lower, sz.triggeredBy.level, 'supply render-lower snaps to broken low');
  assert(onS.upper > onS.lower, 'supply render bounds stay ordered');
});

// ----------------------------------------------------------------------------
// 13. until_tested: touchedAtBarIdx = first bar whose range touches the OB
//     (drives the "碰到就停" right-edge freeze).
// ----------------------------------------------------------------------------
test('until_tested: touchedAtBarIdx = first bar to touch the OB body', () => {
  const { bars, seq } = buildScenario({
    length: 16,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low',  price: 98  },
      { barIdx: 7, type: 'high', price: 115 },   // supply OB ~[114,115]
      { barIdx: 9, type: 'low',  price: 104 },
    ],
    overrides: {
      10: { open: 105, high: 105, low: 99,  close: 100 },  // CHoCh down break
      11: { open: 100, high: 102, low: 98,  close: 100 },  // below OB, no touch
      12: { open: 100, high: 108, low: 100, close: 106 },  // high 108 < OB bottom, no touch
      13: { open: 106, high: 116, low: 106, close: 110 },  // high 116 reaches OB → FIRST touch
      14: { open: 110, high: 112, low: 108, close: 110 },
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  const zones = Z.detectZones(events, seq, bars, withDefaults({ right_strength: 1, sweep_threshold_pct: 100 }));
  const z = zones.find(x => x.side === 'supply');
  assert(z, 'supply zone exists');
  assertEq(z.touchedAtBarIdx, 13, 'first touch recorded at bar 13');
});

// ----------------------------------------------------------------------------
// 14. REGRESSION (user report 2026-05-22): origin must be the pullback low
//     that was active at the break — NOT the low before the broken high.
//     The broken high (b7) is older; the fresh pullback low (b9) sits AFTER
//     it. Old _findOrigin returned b5 (the low before b7) → OB drawn on the
//     wrong, earlier candle. New code anchors on b9.
// ----------------------------------------------------------------------------
test('regression: demand origin = pullback low active at break, not low before broken high', () => {
  const { bars, seq } = buildScenario({
    length: 16,
    pivots: [
      { barIdx: 1, type: 'low',  price: 100 },
      { barIdx: 3, type: 'high', price: 110 },
      { barIdx: 5, type: 'low',  price: 102 },   // OLD low (before the broken high) — WRONG anchor
      { barIdx: 7, type: 'high', price: 115 },   // broken high (older)
      { barIdx: 9, type: 'low',  price: 108 },   // pullback low active at break — CORRECT anchor
    ],
    overrides: {
      11: { open: 110, high: 118, low: 110, close: 117 },  // BOS up: breaks the b7 high (115)
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, { ...D.defaultParams, right_strength: 1 });
  // The break of the b7 high (level 115) confirmed at bar 11.
  const brk = events.find(e => e.level === 115 && e.eventBarIdx === 11);
  assert(brk, `BOS breaking the b7 high should fire; events: ${events.map(e=>`${e.type}@${e.eventBarIdx}/L${e.level}`).join(',')}`);
  assertEq(brk.obPivotBarIdx, 9, 'event carries pullback low (b9) as OB pivot');

  const zones = Z.detectZones(events, seq, bars, withDefaults({ right_strength: 1 }));
  const z = zones.find(x => x.triggeredBy.eventBarIdx === 11 && x.side === 'demand');
  assert(z, 'demand zone for the b7-high break exists');
  assertEq(z.origin.barIdx, 9, 'origin anchored on the pullback low (b9), not the older low (b5)');
  assertEq(z.origin.price, 108, 'origin price = pullback low');
});

// ----------------------------------------------------------------------------
//  Summary
// ----------------------------------------------------------------------------
console.log(`\n=== Result: ${_testCount - _failCount}/${_testCount} passed ===\n`);
if (_failCount > 0) process.exit(1);
