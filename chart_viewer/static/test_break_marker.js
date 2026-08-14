/* ============================================================================
 * test_break_marker.js — tests for the Wister Span/BreakMarker engine port.
 * Run with:  node static/test_break_marker.js
 * ========================================================================== */
global.window = { addEventListener() {}, dispatchEvent() {} };
require('./indicators/break_marker.js');
const BM = global.window.BreakMarker;
if (!BM) { console.error('FAIL: BreakMarker not loaded'); process.exit(1); }

let _n = 0, _f = 0;
function test(name, fn) { _n++; try { fn(); console.log('  ✓ ' + name); } catch (e) { _f++; console.error('  ✗ ' + name + '\n      ' + e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

// bar builder: [H,L] rows → bars (O/C filled mid-range, ts spaced 15m)
function mk(rows) {
  return rows.map((r, i) => ({ timestamp: 1700000000000 + i * 900000, open: (r[0] + r[1]) / 2, high: r[0], low: r[1], close: (r[0] + r[1]) / 2 }));
}

console.log('\n=== Break Marker (Wister Span port) ===');

// ---- level bands: floor(log2(span)) ----
test('levelOf = floor(log2 span)', () => {
  assert(BM.levelOf(1) === 0, 'span1→L0');
  assert(BM.levelOf(3) === 1, 'span3→L1');
  assert(BM.levelOf(4) === 2 && BM.levelOf(7) === 2, 'span4-7→L2');
  assert(BM.levelOf(16) === 4 && BM.levelOf(31) === 4, 'span16-31→L4');
});

// ---- _Wister_SwingPivot port: directional state machine, alternating output ----
test('swingPivots: confirms a high on the first lower-low, alternates', () => {
  // rise to a peak (H 14 @bar2) then fall to a trough (L 8 @bar5) then rise.
  const bars = mk([[10, 8], [12, 9], [14, 11], [13, 10], [12, 9], [11, 8], [13, 10]]);
  const pv = BM.swingPivots(bars);
  assert(pv.length >= 2, `≥2 pivots (got ${pv.length})`);
  assert(pv[0].type === 'high' && pv[0].price === 14 && pv[0].barIdx === 2, `1st = high 14 @2 (got ${JSON.stringify(pv[0])})`);
  assert(pv[0].confirmBar === 3, `high confirmed on the first lower-low bar (got ${pv[0].confirmBar})`);
  assert(pv[1].type === 'low' && pv[1].price === 8 && pv[1].barIdx === 5, `2nd = low 8 @5 (got ${JSON.stringify(pv[1])})`);
  assert(pv[1].confirmBar === 6, `low confirmed on the first higher-high bar (got ${pv[1].confirmBar})`);
  // strictly alternating
  for (let i = 1; i < pv.length; i++) assert(pv[i].type !== pv[i - 1].type, 'alternating high/low');
});

// ---- §14 span sub-pivots: add_span flags finer tips, main pivots unchanged ----
test('swingPivots add_span: main pivots identical, span tips flagged', () => {
  const bars = mk([
    [110, 105], [108, 104], [107, 103],   // upper-wick span-high tip at bar1 (108)
    [106, 100], [104, 98], [103, 96],      // falling → main low pivot forms
    [105, 99], [108, 102], [112, 106],     // rising → main high pivot forms
    [110, 104], [107, 101], [104, 99],
  ]);
  const plain = BM.swingPivots(bars);
  const withSpan = BM.swingPivots(bars, { add_span: true });
  const mainOnly = withSpan.filter(p => !p.isSpan);
  assert(JSON.stringify(mainOnly) === JSON.stringify(plain), 'main pivots unchanged by add_span');
  assert(plain.every(p => !p.isSpan), 'plain has no span tips');
  const span = withSpan.filter(p => p.isSpan);
  assert(span.length >= 1, `≥1 span tip (got ${span.length})`);
  // the bar1 tip: span high at barIdx 1, price 108, confirmed on the next bar
  const t = span.find(p => p.type === 'high' && p.barIdx === 1);
  assert(t && t.price === 108 && t.confirmBar === 2, `bar1 span high 108 @confirm 2 (got ${JSON.stringify(t)})`);
});

// ---- high side: a higher break confirms an earlier lower span-fit CHoCH (BOS) ----
// H1=100@bar2 breaks @bar4 (span2, CHoCH). H2=103@bar8 breaks @bar12 (span4);
// it looks back, finds H1 (earlier/lower/span-fit), clears the chain ceiling →
// BOS confirming H1. Lows are kept from making new lows so the lo side is quiet.
const rows = [
  [95, 92], [96, 93], [100, 94], [97, 95], [101, 95], [98, 93], [99, 94], [98, 94],
  [103, 95], [100, 96], [101, 96], [102, 97], [104, 98], [103, 98],
];
const pivots = [
  { barIdx: 2, price: 100, type: 'high' },
  { barIdx: 5, price: 93,  type: 'low'  },
  { barIdx: 8, price: 103, type: 'high' },
];

test('high-side BOS pairing: H2 confirms earlier lower H1', () => {
  const { hi, log } = BM.detect(mk(rows), pivots, { right_strength: 1, min_break_gap: 2 });
  const breaks = log.filter(l => l.startsWith('BREAK'));
  const boss   = log.filter(l => l.startsWith('BOS'));
  assert(breaks.length >= 2, `≥2 BREAK (got ${breaks.length})`);
  assert(boss.length >= 1, `≥1 BOS (got ${boss.length})`);

  const H1 = hi.find(e => e.bar === 2);
  const H2 = hi.find(e => e.bar === 8);
  assert(H1 && H2, 'both highs in ledger');
  assert(H1.status === BM.ST_CHOCH, 'H1 broke → CHoCH');
  assert(H1.isConfirmed === true, 'H1 was confirmed by H2');
  assert(H2.isBOS === true, 'H2 is a BOS');
  assert(H2.span === 4 && H1.span === 2, `spans (H1=${H1.span}, H2=${H2.span})`);
});

test('lo side stays quiet when no new lows form', () => {
  const { lo } = BM.detect(mk(rows), pivots, { right_strength: 1, min_break_gap: 2 });
  const L = lo.find(e => e.bar === 5);
  assert(L, 'low pivot ledgered');
  assert(L.status === BM.ST_ALIVE, 'low never broke → still ALIVE');
});

// ---- high side: terminator seals a later, lower CHoCH ----
// X=105@bar2 breaks @bar12 (span10). floor=101@bar6 breaks @bar8 (span2). floor
// is later-created + lower + CHoCH, so when X breaks it is a terminator and
// seals the floor.
test('high-side terminator seals a later lower CHoCH', () => {
  const hrows = [
    [100, 95], [101, 96], [105, 98], [102, 97], [100, 96], [99, 95], [101, 96], [98, 95],
    [102, 97], [100, 96], [101, 96], [103, 97], [106, 98], [104, 98],
  ];
  const hp = [{ barIdx: 2, price: 105, type: 'high' }, { barIdx: 6, price: 101, type: 'high' }];
  const { hi, log } = BM.detect(mk(hrows), hp, { right_strength: 1, min_break_gap: 2 });
  const X = hi.find(e => e.bar === 2);
  const floor = hi.find(e => e.bar === 6);
  assert(X.isTerminator === true, 'X is a terminator');
  assert(floor.status === BM.ST_CLOSED, 'floor got sealed (CLOSED)');
  assert(log.some(l => l.startsWith('TERMINATOR')), 'TERMINATOR logged');
});

// ---- low side: terminator seals a later HIGHER low (validates the corrected
// seal direction; the v0.06 .el sealed the wrong side) ----
test('low-side terminator seals a later HIGHER low (corrected direction)', () => {
  const lrows = [
    [105, 102], [104, 101], [103, 100], [103, 101], [104, 103], [105, 105], [108, 104], [107, 106],
    [106, 103], [105, 104], [104, 103], [103, 102], [102, 99], [101, 100],
  ];
  const lp = [{ barIdx: 2, price: 100, type: 'low' }, { barIdx: 6, price: 104, type: 'low' }];
  const { lo, log } = BM.detect(mk(lrows), lp, { right_strength: 1, min_break_gap: 2 });
  const X = lo.find(e => e.bar === 2);        // the lower low (terminator)
  const ceil = lo.find(e => e.bar === 6);     // the later HIGHER low (should be sealed)
  assert(X.isTerminator === true, 'low-side X is a terminator');
  assert(ceil.status === BM.ST_CLOSED, 'the higher later low got sealed (proves corrected direction)');
});

// ---- MERGE: a same-price latecomer with an out-of-band span folds into the
// older CHoCH; the survivor keeps its identity, recomputes span old-start→break,
// and becomes a terminator. ----
test('MERGE: same-price out-of-band break folds into the older level', () => {
  const mrows = [
    [96, 93], [97, 94], [100, 95], [98, 95], [100, 95], [97, 94], [100, 95], [98, 94],
    [99, 95], [98, 94], [99, 95], [98, 94], [99, 95], [97, 94], [100, 95], [98, 94],
  ];
  const mp = [{ barIdx: 2, price: 100, type: 'high' }, { barIdx: 6, price: 100, type: 'high' }];
  const { hi, log } = BM.detect(mk(mrows), mp, { right_strength: 1, min_break_gap: 2 });
  const older = hi.find(e => e.bar === 2);
  const latecomer = hi.find(e => e.bar === 6);
  assert(log.some(l => l.startsWith('MERGE')), 'MERGE logged');
  assert(latecomer.status === BM.ST_CLOSED, 'latecomer retired (CLOSED)');
  assert(older.status === BM.ST_CHOCH, 'older survives');
  assert(older.span === 12, `older span recomputed old-start→break (got ${older.span})`);
  assert(older.isTerminator === true, 'merged super-CHoCH acts as terminator');
});

// ---- SOURCE PROTECTION (log2 level): a small-level terminator K cannot seal a
// larger-level terminator C even though C is lower-priced (a seal candidate).
// An ordinary/lower-level point V at the same "below K" position IS sealed —
// so the only reason C survives is level(C) > level(K). ----
test('source protection: higher-level terminator survives a smaller killer', () => {
  const prows = [
    [100, 95], [101, 96], [110, 100], [104, 99], [106, 100], [103, 98], [107, 101], [104, 99],
    [103, 98], [102, 97], [104, 99], [103, 98], [105, 100], [104, 99], [103, 98], [106, 101],
    [105, 100], [110, 101], [112, 103], [125, 110], [120, 108], [121, 109], [122, 110], [126, 112], [124, 111],
  ];
  const pp = [
    { barIdx: 2,  price: 110, type: 'high' },   // C — big terminator
    { barIdx: 4,  price: 106, type: 'high' },   // cf — C's floor
    { barIdx: 20, price: 125, type: 'high' },   // K — small killer terminator
    { barIdx: 21, price: 120, type: 'high' },   // V — K's floor (sealed)
  ];
  const { hi } = BM.detect(mk(prows), pp, { right_strength: 1, min_break_gap: 2 });
  const C = hi.find(e => e.bar === 2);
  const K = hi.find(e => e.bar === 20);
  const V = hi.find(e => e.bar === 21);
  // preconditions: C is lower than K (so a seal candidate), both terminators
  assert(C.isTerminator && K.isTerminator, 'C and K are both terminators');
  assert(C.price < K.price, 'C is lower-priced than K (would be sealed if unprotected)');
  assert(BM.levelOf(C.span) > BM.levelOf(K.span), `level(C)=${BM.levelOf(C.span)} > level(K)=${BM.levelOf(K.span)}`);
  // the payoff: C survives, the ordinary lower V got sealed by K
  assert(C.status === BM.ST_CHOCH, 'C survived K (protected by level)');
  assert(V.status === BM.ST_CLOSED, 'ordinary lower V was sealed (seal is active)');
});

// ---- REAL MC OUTPUT: every event in a full month of TXF1 15Min must satisfy
// the exact rules this engine encodes. Validates rule-fidelity against ground
// truth without needing bars. Fixture = test_data/TXF1_15Min_BreakMarker_MC.csv
// (exported from `_Wister_Span_v0.06`; 2023/01/04–2023/02/01, ~1058 events). ----
test('MC oracle: a month of TXF1 15Min events obey the engine rules', () => {
  const fs = require('fs'), path = require('path');
  const file = path.join(__dirname, '..', 'test_data', 'TXF1_15Min_BreakMarker_MC.csv');
  let csv;
  try { csv = fs.readFileSync(file, 'utf8'); }
  catch (e) { console.log('      (skipped — MC fixture not present)'); return; }

  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  const hdr = lines[0].split(',');
  const rows = lines.slice(1).map(l => { const c = l.split(','); const o = {}; hdr.forEach((h, i) => o[h] = c[i]); return o; });
  const num = x => parseFloat(x);
  const kv = (extra, key) => { const m = (extra || '').match(new RegExp(key + '=([\\-0-9.]+)')); return m ? parseFloat(m[1]) : null; };

  const LO = BM.defaultParams.span_ratio_lo, HI = BM.defaultParams.span_ratio_hi;
  let bos = 0, dirV = 0, spanV = 0, ceilV = 0, term = 0, termV = 0;
  for (const r of rows) {
    const price = num(r.price), span = parseInt(r.span, 10), refp = num(r.ref_price);
    if (r.event === 'BOS') {
      bos++;
      if (r.side === 'HI' && !(price > refp)) dirV++;      // HI BOS breaks ABOVE its Y
      if (r.side === 'LO' && !(price < refp)) dirV++;      // LO BOS breaks BELOW its Y
      const ys = kv(r.extra, 'Yspan');
      if (ys != null && !(span >= ys * LO && span <= ys * HI)) spanV++;   // 2x span gate
      const cc = kv(r.extra, 'chainCeil'), cf = kv(r.extra, 'chainFloor');
      if (r.side === 'HI' && cc != null && !(price >= cc)) ceilV++;       // cleared the ceiling
      if (r.side === 'LO' && cf != null && !(price <= cf)) ceilV++;
    } else if (r.event === 'TERMINATOR') {
      term++;
      if (r.side === 'HI' && !(refp < price)) termV++;     // HI terminator's floor is lower
      if (r.side === 'LO' && !(refp > price)) termV++;     // LO terminator's ceil is higher
    }
  }
  console.log(`      MC events: ${rows.length} | BOS ${bos} (dir ${dirV}, span ${spanV}, ceil ${ceilV}) | TERM ${term} (dir ${termV})`);
  assert(bos > 100 && term > 100, 'fixture has a substantial event count');
  assert(dirV === 0, `BOS direction violations: ${dirV}`);
  assert(spanV === 0, `BOS span-gate violations: ${spanV}`);
  assert(ceilV === 0, `BOS ceiling violations: ${ceilV}`);
  assert(termV === 0, `TERMINATOR direction violations: ${termV}`);
});

// ---- print the full event log for eyeballing ----
test('[dump] high-side log', () => {
  const { log } = BM.detect(mk(rows), pivots, { right_strength: 1, min_break_gap: 2 });
  log.forEach(l => console.log('      ' + l));
  assert(true);
});

console.log(`\n=== Result: ${_n - _f}/${_n} passed ===`);
if (_f) process.exit(1);
