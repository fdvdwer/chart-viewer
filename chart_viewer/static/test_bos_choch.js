/* ============================================================================
 * test_bos_choch.js — Sanity tests for the BOS / CHoCh state machine.
 * ============================================================================
 * Run with:  node static/test_bos_choch.js
 *
 * Test data is built via `buildScenario({pivots, length, overrides})`:
 *   - Bars between pivots get linear-interpolated OHLC so they don't
 *     accidentally trigger spurious swing-high/low breaks.
 *   - Bars at pivot indices have their high (or low) set to the pivot's
 *     price; open/close clamped to that side of the pivot.
 *   - Bars listed in `overrides` win — used for the explicit break bars
 *     that the scenario is testing.
 *
 * This isolates the state-machine logic from N Wave's pivot detection
 * (validated separately in N Wave's own tests). We feed pivot seq + bars
 * straight into `detectEventsFromSeq`.
 * ========================================================================== */

global.window = { addEventListener: () => {}, dispatchEvent: () => {} };
require('./indicators/n_wave.js');
require('./indicators/bos_choch.js');

const D = global.window.BOSChoChDetector;
if (!D) {
  console.error('FAIL: BOSChoChDetector not loaded');
  process.exit(1);
}

const DEFAULTS = D.defaultParams;
const TS0 = 1700000000000;
const TF_MS = 300000;   // 5min

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
  }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'assertEq'} — expected ${e}, got ${a}`);
}

// ---- Fixture builder ----------------------------------------------------------

function buildScenario({ pivots, length, overrides }) {
  // Sort pivots by barIdx (stable)
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

  // (1) Bars BEFORE first pivot: copy first pivot's price flat
  if (sorted.length > 0) {
    const first = sorted[0];
    for (let i = 0; i < first.barIdx; i++) {
      bars[i].open = first.price; bars[i].close = first.price;
      bars[i].high = first.price; bars[i].low = first.price;
    }
  }

  // (2) Between adjacent pivots: linear interpolation. This guarantees no
  //     bar mid-way "breaks" a pivot — the interp value is always strictly
  //     inside [low_pivot, high_pivot] of the surrounding pair.
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    for (let k = a.barIdx + 1; k < b.barIdx; k++) {
      const t = (k - a.barIdx) / (b.barIdx - a.barIdx);
      const v = a.price + (b.price - a.price) * t;
      bars[k].open = v; bars[k].close = v;
      bars[k].high = v; bars[k].low = v;
    }
  }

  // (3) Bars AFTER last pivot: step ONE unit away from the pivot extreme.
  //     For a final low pivot, bars float just above it (no down break).
  //     For a final high pivot, bars float just below it (no up break).
  //     This is enough margin for our strict-> tests.
  if (sorted.length > 0) {
    const last = sorted[sorted.length - 1];
    const v = last.type === 'high' ? last.price - 1 : last.price + 1;
    for (let i = last.barIdx + 1; i < length; i++) {
      bars[i].open = v; bars[i].close = v;
      bars[i].high = v; bars[i].low = v;
    }
  }

  // (4) Set pivot bars' OHLC. For a high pivot at price P:
  //     - bar.high = P (the swing extreme)
  //     - bar.open, close, low = P - 1 (a "tall upper wick" candle whose body
  //       sits just below the high)
  //     For a low pivot: mirrored — body sits just above the low.
  //
  //     This UNCONDITIONALLY overrides whatever steps (1)-(3) put on the
  //     pivot bar — those steps may have left basePrice values that would
  //     surprise the state machine (e.g. a high pivot far from basePrice
  //     leaves bar.close = basePrice, which could fall below an active
  //     swingLow and trigger a spurious down-break).
  for (const p of sorted) {
    const b = bars[p.barIdx];
    if (p.type === 'high') {
      b.high  = p.price;
      b.open  = p.price - 1;
      b.close = p.price - 1;
      b.low   = p.price - 1;
    } else {
      b.low   = p.price;
      b.open  = p.price + 1;
      b.close = p.price + 1;
      b.high  = p.price + 1;
    }
  }

  // (5) Apply explicit overrides last — these are the break-test bars.
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      const idx = Number(k);
      const o = overrides[k];
      const b = bars[idx];
      if (o.open  !== undefined) b.open  = o.open;
      if (o.high  !== undefined) b.high  = o.high;
      if (o.low   !== undefined) b.low   = o.low;
      if (o.close !== undefined) b.close = o.close;
    }
  }

  // Build seq with ts from bar index
  const seq = sorted.map(p => ({
    barIdx: p.barIdx,
    type:   p.type,
    price:  p.price,
    ts:     TS0 + p.barIdx * TF_MS,
  }));

  return { bars, seq };
}

function withDefaults(o) { return { ...DEFAULTS, ...o }; }

// ============================================================================
//  SCENARIOS
// ============================================================================

console.log('\n=== BOS / CHoCh state machine ===');

// ----------------------------------------------------------------------------
// 1. Initial up-trend → BOS up at break of swing high
// ----------------------------------------------------------------------------
test('initial up-trend, BOS up at break of swing high', () => {
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
      11: { open: 110, high: 118, low: 110, close: 117 },   // BOS up: close > 115
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, withDefaults({ right_strength: 1 }));
  assertEq(events.length, 1, 'should emit exactly one event');
  const ev = events[0];
  assertEq(ev.type, 'BOS');
  assertEq(ev.direction, 'up');
  assertEq(ev.eventBarIdx, 11);
  assertEq(ev.pivotBarIdx, 7);
  assertEq(ev.level, 115);
  assertEq(ev.trendBefore, 'up');
});

// ----------------------------------------------------------------------------
// 2. Initial down-trend → BOS down at break of swing low (mirror)
// ----------------------------------------------------------------------------
test('initial down-trend, BOS down at break of swing low', () => {
  const { bars, seq } = buildScenario({
    length: 14,
    pivots: [
      { barIdx: 1, type: 'high', price: 110 },
      { barIdx: 3, type: 'low',  price: 95  },
      { barIdx: 5, type: 'high', price: 103 },
      { barIdx: 7, type: 'low',  price: 92  },
      { barIdx: 9, type: 'high', price: 98  },
    ],
    overrides: {
      11: { open: 90, high: 90, low: 86, close: 88 },   // BOS down: close < 92
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, withDefaults({ right_strength: 1 }));
  assertEq(events.length, 1);
  assertEq(events[0].type, 'BOS');
  assertEq(events[0].direction, 'down');
  assertEq(events[0].eventBarIdx, 11);
  assertEq(events[0].pivotBarIdx, 7);
  assertEq(events[0].level, 92);
});

// ----------------------------------------------------------------------------
// 3. Uptrend → CHoCh down at break of swing low
// ----------------------------------------------------------------------------
test('uptrend → CHoCh down at break of swing low', () => {
  const { bars, seq } = buildScenario({
    length: 12,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low',  price: 98  },
      { barIdx: 7, type: 'high', price: 115 },
      { barIdx: 9, type: 'low',  price: 104 },
    ],
    overrides: {
      10: { open: 105, high: 105, low: 99, close: 100 },   // CHoCh down: close < 104
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, withDefaults({ right_strength: 1 }));
  assertEq(events.length, 1);
  assertEq(events[0].type, 'CHoCh');
  assertEq(events[0].direction, 'down');
  assertEq(events[0].eventBarIdx, 10);
  assertEq(events[0].level, 104);
  assertEq(events[0].trendBefore, 'up');
});

// ----------------------------------------------------------------------------
// 4. Downtrend → CHoCh up at break of swing high (mirror)
// ----------------------------------------------------------------------------
test('downtrend → CHoCh up at break of swing high', () => {
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
      10: { open: 96, high: 103, low: 96, close: 102 },   // CHoCh up: close > 98
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, withDefaults({ right_strength: 1 }));
  assertEq(events.length, 1);
  assertEq(events[0].type, 'CHoCh');
  assertEq(events[0].direction, 'up');
  assertEq(events[0].eventBarIdx, 10);
  assertEq(events[0].level, 98);
});

// ----------------------------------------------------------------------------
// 5. §1-1 enforcement: CHoCh suppressed when broken low above lastBOS.level
//
//   Uptrend → BOS up at b11 (level=115). Later, low pivot at 120 (ABOVE 115)
//   gets broken. Per §1-1, this would-be CHoCh DOWN is suppressed because
//   120 >= lastBOS.level=115.
// ----------------------------------------------------------------------------
test('§1-1 enforcement: CHoCh suppressed when broken low above lastBOS', () => {
  const { bars, seq } = buildScenario({
    length: 20,
    pivots: [
      { barIdx: 1,  type: 'low',  price: 95  },
      { barIdx: 3,  type: 'high', price: 108 },
      { barIdx: 5,  type: 'low',  price: 98  },
      { barIdx: 7,  type: 'high', price: 115 },
      { barIdx: 9,  type: 'low',  price: 104 },
      { barIdx: 13, type: 'high', price: 125 },
      { barIdx: 15, type: 'low',  price: 120 },
    ],
    overrides: {
      11: { open: 110, high: 118, low: 110, close: 117 },   // BOS up @ 115
      17: { open: 121, high: 121, low: 118, close: 119 },   // would-break L4=120
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, withDefaults({ right_strength: 1, enforce_choch_below_bos: true }));
  assertEq(events.length, 1, 'only BOS should emit');
  assertEq(events[0].type, 'BOS');
  assertEq(events[0].direction, 'up');
  assertEq(events[0].eventBarIdx, 11);
});

// ----------------------------------------------------------------------------
// 6. §1-1 toggle off: same setup, CHoCh fires.
// ----------------------------------------------------------------------------
test('§1-1 disabled: CHoCh fires even if level >= lastBOS', () => {
  const { bars, seq } = buildScenario({
    length: 20,
    pivots: [
      { barIdx: 1,  type: 'low',  price: 95  },
      { barIdx: 3,  type: 'high', price: 108 },
      { barIdx: 5,  type: 'low',  price: 98  },
      { barIdx: 7,  type: 'high', price: 115 },
      { barIdx: 9,  type: 'low',  price: 104 },
      { barIdx: 13, type: 'high', price: 125 },
      { barIdx: 15, type: 'low',  price: 120 },
    ],
    overrides: {
      11: { open: 110, high: 118, low: 110, close: 117 },
      17: { open: 121, high: 121, low: 118, close: 119 },
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, withDefaults({ right_strength: 1, enforce_choch_below_bos: false }));
  assertEq(events.length, 2);
  assertEq(events[0].type, 'BOS');
  assertEq(events[1].type, 'CHoCh');
  assertEq(events[1].eventBarIdx, 17);
});

// ----------------------------------------------------------------------------
// 7. Ambiguous initial pivots (HH but LL) → trend stays 'unknown', no events
// ----------------------------------------------------------------------------
test('ambiguous initial trend, no events emitted', () => {
  const { bars, seq } = buildScenario({
    length: 15,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 110 },
      { barIdx: 5, type: 'low',  price: 88  },   // LL (88 < 95)
      { barIdx: 7, type: 'high', price: 125 },   // HH (125 > 110) — mixed → unknown
      { barIdx: 9, type: 'low',  price: 80  },
    ],
    overrides: {
      13: { open: 115, high: 131, low: 115, close: 130 },   // would-be break of H2=125
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, withDefaults({ right_strength: 1 }));
  assertEq(events.length, 0, 'no events when trend unknown');
});

// ----------------------------------------------------------------------------
// 8. Wick vs close break — require_close_break toggles the behaviour
// ----------------------------------------------------------------------------
test('wick-only break: suppressed with require_close_break=true', () => {
  const { bars, seq } = buildScenario({
    length: 12,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low',  price: 98  },
      { barIdx: 7, type: 'high', price: 115 },
      { barIdx: 9, type: 'low',  price: 104 },
    ],
    overrides: {
      11: { open: 112, high: 119, low: 110, close: 113 },   // wick 119 > 115, close 113 < 115
    },
  });

  const evClose = D.detectEventsFromSeq(seq, bars, withDefaults({ right_strength: 1, require_close_break: true }));
  assertEq(evClose.length, 0, 'close=113 < 115, no break');

  const evWick = D.detectEventsFromSeq(seq, bars, withDefaults({ right_strength: 1, require_close_break: false }));
  assertEq(evWick.length, 1, 'wick=119 > 115, break fires');
  assertEq(evWick[0].type, 'BOS');
});

// ----------------------------------------------------------------------------
// 9. Strict comparison: bar.close == swingHigh.price should NOT trigger
// ----------------------------------------------------------------------------
test('strict comparison: equal-price close does not break', () => {
  const { bars, seq } = buildScenario({
    length: 12,
    pivots: [
      { barIdx: 1, type: 'low',  price: 95  },
      { barIdx: 3, type: 'high', price: 108 },
      { barIdx: 5, type: 'low',  price: 98  },
      { barIdx: 7, type: 'high', price: 115 },
      { barIdx: 9, type: 'low',  price: 104 },
    ],
    overrides: {
      11: { open: 110, high: 115, low: 110, close: 115 },   // close exactly 115, not strict >
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, withDefaults({ right_strength: 1 }));
  assertEq(events.length, 0);
});

// ----------------------------------------------------------------------------
// 10. Chain: CHoCh down followed by BOS down (trend flip → with-trend break)
// ----------------------------------------------------------------------------
test('CHoCh down then BOS down chain', () => {
  const { bars, seq } = buildScenario({
    length: 16,
    pivots: [
      { barIdx: 1,  type: 'low',  price: 95  },
      { barIdx: 3,  type: 'high', price: 108 },
      { barIdx: 5,  type: 'low',  price: 98  },
      { barIdx: 7,  type: 'high', price: 115 },
      { barIdx: 9,  type: 'low',  price: 104 },
      { barIdx: 11, type: 'high', price: 99  },
      { barIdx: 13, type: 'low',  price: 88  },
    ],
    overrides: {
      10: { open: 105, high: 105, low: 99,  close: 100 },   // CHoCh down: breaks L3=104
      14: { open: 89,  high: 89,  low: 78,  close: 80 },    // BOS down: breaks L4=88
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, withDefaults({ right_strength: 1 }));
  assertEq(events.length, 2, `should be 2 events, got ${events.length}: ${JSON.stringify(events.map(e => [e.type, e.direction, e.eventBarIdx]))}`);
  assertEq(events[0].type, 'CHoCh');
  assertEq(events[0].direction, 'down');
  assertEq(events[1].type, 'BOS');
  assertEq(events[1].direction, 'down');
  assertEq(events[1].level, 88);
});

// ----------------------------------------------------------------------------
// 11. REGRESSION (user 2026-05): one bar that breaks SEVERAL lower-highs at
//     once must mark the BIGGEST broken, not the nearest. Descending lower-
//     highs 120 / 115 / 110 in a downtrend; an up-bar takes out 115 AND 110
//     (not 120) → CHoCh up at 115, not 110.
// ----------------------------------------------------------------------------
test('multi-break resolves to the biggest high broken, not the nearest', () => {
  const { bars, seq } = buildScenario({
    length: 18,
    pivots: [
      { barIdx: 1,  type: 'high', price: 120 },
      { barIdx: 3,  type: 'low',  price: 100 },
      { barIdx: 5,  type: 'high', price: 115 },
      { barIdx: 7,  type: 'low',  price: 95  },
      { barIdx: 9,  type: 'high', price: 110 },
      { barIdx: 11, type: 'low',  price: 90  },
    ],
    overrides: {
      15: { open: 92, high: 117, low: 92, close: 116 },  // breaks 110 AND 115 (not 120)
    },
  });
  const events = D.detectEventsFromSeq(seq, bars, withDefaults({ right_strength: 1 }));
  const choch = events.find(e => e.type === 'CHoCh' && e.direction === 'up');
  assertEq(!!choch, true, `CHoCh up should fire; got ${JSON.stringify(events.map(e => [e.type, e.direction, e.level]))}`);
  assertEq(choch.level, 115, 'resolves to the highest broken (115), not the nearest (110)');
});

// ----------------------------------------------------------------------------
//  Summary
// ----------------------------------------------------------------------------
console.log(`\n=== Result: ${_testCount - _failCount}/${_testCount} passed ===\n`);
if (_failCount > 0) process.exit(1);
