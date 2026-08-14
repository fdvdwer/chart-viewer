/* ============================================================================
 * test_span_structure.js — tests for the all-bar span/degree CHoCh-BOS core.
 * Run with:  node static/test_span_structure.js
 * ========================================================================== */
global.window = { addEventListener: () => {}, dispatchEvent: () => {} };
require('./indicators/n_wave.js');        // N-wave backbone deps (trend skeleton)
require('./indicators/bos_choch.js');
require('./indicators/span_structure.js');
const S = global.window.SpanStructure;
if (!S) { console.error('FAIL: SpanStructure not loaded'); process.exit(1); }

let _n = 0, _f = 0;
function test(name, fn) { _n++; try { fn(); console.log('  ✓ ' + name); } catch (e) { _f++; console.error('  ✗ ' + name + '\n      ' + e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || 'eq') + ` — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// bar builder: array of [O,H,L,C] → kline bars
function mk(rows) { return rows.map((r, i) => ({ timestamp: 1700000000000 + i * 1800000, open: r[0], high: r[1], low: r[2], close: r[3] })); }

console.log('\n=== Span Structure ===');

// ---- degreeOf (pure bands) ----
test('degreeOf bands (小<10 / 中10~30 / 大>=30)', () => {
  const p = { degree_mid_min: 10, degree_large_min: 30 };
  eq(S.degreeOf(4, p), 'small');
  eq(S.degreeOf(9, p), 'small');
  eq(S.degreeOf(10, p), 'mid');
  eq(S.degreeOf(29, p), 'mid');
  eq(S.degreeOf(30, p), 'large');
  eq(S.degreeOf(72, p), 'large');
});

// A clean sawtooth uptrend (impulse up, shallow higher-low pullback, repeat) —
// enough swing structure for the strength-1 N-wave backbone to resolve trend=up.
function sawUp(legs) {
  const rows = []; let p = 1000;
  for (let i = 0; i < legs; i++) {
    for (let j = 0; j < 4; j++) { p += 15; rows.push([p - 12, p + 3, p - 15, p]); }   // impulse up
    for (let j = 0; j < 3; j++) { p -= 8;  rows.push([p + 6, p + 9, p - 3, p]); }      // higher-low pullback
  }
  return mk(rows);
}

// ---- hybrid: backbone resolves trend; up-trend prints up-BOS, §1-1 holds ----
test('backbone-driven: rising series fires BOS up + keeps §1-1', () => {
  const ev = S.detectSpanEvents(sawUp(5), { min_span: 1, backbone_strength: 1, max_span: 0 });
  assert(ev.length > 0, 'events fired (backbone resolved a trend)');
  assert(ev.some(e => e.type === 'BOS' && e.direction === 'up'), 'an up-trend prints bull BOS');
  // §1-1 per direction: every BOS extends its direction's CHoCh
  const an = { up: null, down: null };
  for (const e of ev.slice().sort((a, b) => a.eventBarIdx - b.eventBarIdx)) {
    if (e.state === 'invalidated') continue;   // X events are exempt from §1-1
    if (e.type === 'CHoCh') an[e.direction] = e.level;
    else { if (an[e.direction] != null) assert(e.direction === 'up' ? e.level > an[e.direction] : e.level < an[e.direction], '§1-1'); an[e.direction] = e.level; }
  }
});

// ---- min_span drops micro-noise ----
test('min_span filters sub-threshold breaks', () => {
  const bars = sawUp(5);
  const none = S.detectSpanEvents(bars, { min_span: 999, backbone_strength: 1 });
  eq(none.length, 0, 'all breaks below min_span → no events');
  const some = S.detectSpanEvents(bars, { min_span: 1, backbone_strength: 1 });
  assert(some.length >= 1, 'min_span 1 lets them through');
});

// ---- REAL DATA: 2026/05/14 — the all-bar engine SEES the 10:00 high (span 9) ----
// NOTE (open trade-off, pending user decision): the strength-3 engine could not
// even form the 10:00 swing high; the all-bar leg builder DOES (it is a span-9
// up-leg). Whether it's EMITTED as a structural event depends on the dual-aware
// structure rules: at 15:30 the small trend is still bullish and 41871 is below
// the prevailing small high, so under §1-1 (a bull BOS must make a higher high)
// it is currently classified as INTERNAL, not emitted. This test asserts the
// leg is *detectable* (via min_span=1, where the structure rules emit more),
// documenting the capability without locking the labelling decision.
test('real 05/14: the 10:00 high (41871) is a detectable structural level', () => {
  let bars;
  try { bars = require('../test_data/bars30.json'); }
  catch (e) { console.log('      (skipped — bars30.json not present)'); return; }
  const etOf = i => bars[i] && bars[i].et;
  // The all-bar engine can resolve a break to the 10:00 high — strength-N can't.
  const ev = S.detectSpanEvents(bars, { min_span: 1, require_close_break: false });
  const seen = ev.some(e => Math.abs(e.level - 41871) < 1 && etOf(e.pivotBarIdx) === '2026/05/14 10:00');
  assert(seen, 'the 10:00 high (41871) appears as a broken pivot somewhere');
});

// ---- REAL DATA: coverage + no stacked-staircase (leg-merge works) ----
test('real: bands carry BOS+CHoCh; no stacked same-dir staircase', () => {
  let bars;
  try { bars = require('../test_data/bars30.json'); }
  catch (e) { console.log('      (skipped — bars30.json not present)'); return; }
  const ev = S.detectSpanEvents(bars, { min_span: 4, require_close_break: false });
  // each band has events of both types (not the old all-one-type bug)
  for (const band of ['small', 'mid']) {
    const be = ev.filter(e => e.degree === band);
    assert(be.some(e => e.type === 'BOS'), `${band} has BOS`);
    assert(be.some(e => e.type === 'CHoCh'), `${band} has CHoCh`);
  }
  // leg-merge ⇒ no two consecutive same-direction mid events share the SAME
  // broken pivot bar (the old "4 stacked BOS off one staircase" bug).
  const mid = ev.filter(e => e.degree === 'mid').sort((a, b) => a.eventBarIdx - b.eventBarIdx);
  const dupPivot = mid.some((e, i) => i > 0 && mid[i - 1].direction === e.direction && mid[i - 1].pivotBarIdx === e.pivotBarIdx);
  assert(!dupPivot, 'no stacked same-dir events off one pivot');
});

test('real: §1-1 (CHoCh<BOS) + start-rule (CHoCh end ≤ BOS start) hold', () => {
  let bars;
  try { bars = require('../test_data/bars30.json'); }
  catch (e) { console.log('      (skipped — bars30.json not present)'); return; }
  const ev = S.detectSpanEvents(bars, { min_span: 4, require_close_break: false });
  // Single faithful pass mirroring the detector: per (band, direction) anchor,
  // and a confirmed BOS resets the OPPOSITE direction across its own + smaller
  // bands (the v2 cross-trend swallow). Invalidated (X) events are exempt.
  const BR = { small: 0, mid: 1, large: 2 };
  const bandsLE = b => ['small', 'mid', 'large'].filter(x => BR[x] <= BR[b]);
  const st = { small: { up: null, down: null }, mid: { up: null, down: null }, large: { up: null, down: null } };
  const ce = { small: { up: -1, down: -1 }, mid: { up: -1, down: -1 }, large: { up: -1, down: -1 } };
  let checked = 0, s11 = 0, startV = 0;
  for (const e of ev.slice().sort((a, b) => a.eventBarIdx - b.eventBarIdx)) {
    if (e.state === 'invalidated') continue;   // X events don't extend by design
    const d = e.direction, opp = d === 'up' ? 'down' : 'up', b = e.degree;
    if (e.type === 'CHoCh') { st[b][d] = e.level; ce[b][d] = e.eventBarIdx; }
    else {
      checked++;
      if (st[b][d] != null && !(d === 'up' ? e.level > st[b][d] : e.level < st[b][d])) s11++;
      if (ce[b][d] >= 0 && e.pivotBarIdx < ce[b][d]) startV++;
      st[b][d] = e.level;
      for (const bb of bandsLE(b)) { st[bb][opp] = null; ce[bb][opp] = -1; }
    }
  }
  assert(checked > 0, 'some BOS were checked');
  eq(s11, 0, `§1-1 violations: ${s11}`);
  eq(startV, 0, `start-rule violations (BOS start before CHoCh end): ${startV}`);
});

// ---- v2 §4zt: every event carries a state, defaulting to valid ----
test('v2: events carry state (valid by default)', () => {
  const ev = S.detectSpanEvents(sawUp(5), { min_span: 1, backbone_strength: 1 });
  assert(ev.length > 0, 'has events');
  assert(ev.every(e => e.state === 'valid' || e.state === 'invalidated'), 'state present on all');
  assert(ev.some(e => e.state === 'valid'), 'at least one valid');
});

// ---- v2: cross-trend swallow — a confirmed BOS invalidates the opposite CHoCh.
// Synthetic: up-trend, a small down-CHoCh prints (counter-trend warning), then a
// bull BOS makes a higher high → the down-CHoCh must flip to invalidated. ----
test('v2: confirmed BOS swallows the opposite-trend CHoCh (→ X)', () => {
  // up-trend backbone (impulse + higher-low pullbacks, like sawUp) so the
  // counter-trend down-breaks print as down-CHoChs; each is then swallowed when
  // the next bull BOS makes a higher high. Needs enough swing density for the
  // strength-1 backbone to resolve trend=up.
  const rows = []; let p = 1000;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) { p += 15; rows.push([p - 12, p + 3, p - 15, p]); }   // impulse up
    for (let j = 0; j < 3; j++) { p -= 8;  rows.push([p + 6, p + 9, p - 3, p]); }      // higher-low pullback → down CHoCh
  }
  const ev = S.detectSpanEvents(mk(rows), { min_span: 1, backbone_strength: 1, max_span: 0 });
  const downChoch = ev.filter(e => e.type === 'CHoCh' && e.direction === 'down');
  const upBos = ev.filter(e => e.type === 'BOS' && e.direction === 'up');
  assert(upBos.length > 0, 'an up BOS confirmed');
  assert(downChoch.length > 0, 'a down CHoCh printed');
  assert(downChoch.some(e => e.state === 'invalidated'), 'the counter-trend down CHoCh was invalidated by the up BOS');
});

// ---- v2: ground-truth MEASUREMENT vs the user's hand-drawn O/X (05/13 15m).
// Informational — reports match rate, does not gate the suite (the decomposition
// is still being tuned). Skips when the fixtures are absent. ----
test('v2: ground-truth O/X match rate (05/13 15m) [informational]', () => {
  let bars, gt;
  try { bars = require('../test_data/bars15_0513.json'); gt = require('../test_data/ground_truth_0513_15m.json'); }
  catch (e) { console.log('      (skipped — bars15_0513 / ground_truth fixtures not present)'); return; }
  const ev = S.detectSpanEvents(bars, { min_span: 4, backbone_strength: 3, require_close_break: false, max_span: 100 });
  const r = gtScore(ev, gt);   // type + direction + level (directional!)
  console.log(`      [type+dir+level] backbone v1: ${r.lvl}/${gt.length} matched | state(O/X) correct: ${r.stt}`);
  assert(true);   // informational only
});

// ---- v2 'flip' trend mode: trend evolves from the legs, flips on real CHoCh ----
// Faithful §1-1 walk: a CHoCh of ANY state sets that direction's anchor (the
// detector does), an invalidated near-dup BOS sets nothing, a valid BOS must
// extend + resets the opposite direction across its band + smaller (swallow).
function s11Violations(ev) {
  const BR = { small: 0, mid: 1, large: 2 };
  const bandsLE = b => ['small', 'mid', 'large'].filter(x => BR[x] <= BR[b]);
  const st = { small: { up: null, down: null }, mid: { up: null, down: null }, large: { up: null, down: null } };
  let v = 0, chk = 0;
  for (const e of ev.slice().sort((a, b) => a.eventBarIdx - b.eventBarIdx)) {
    const d = e.direction, opp = d === 'up' ? 'down' : 'up', b = e.degree;
    if (e.type === 'CHoCh') { st[b][d] = e.level; }
    else if (e.state === 'invalidated') { /* near-dup BOS-X: no anchor change */ }
    else { chk++; if (st[b][d] != null && !(d === 'up' ? e.level > st[b][d] : e.level < st[b][d])) v++; st[b][d] = e.level; for (const bb of bandsLE(b)) st[bb][opp] = null; }
  }
  return { chk, v };
}

test('flip mode: §1-1 holds (valid BOS always extends its anchor)', () => {
  let bars;
  try { bars = require('../test_data/bars30.json'); }
  catch (e) { console.log('      (skipped — bars30.json not present)'); return; }
  for (const [ms, mx] of [[2, 20], [3, 30], [4, 100]]) {
    const ev = S.detectSpanEvents(bars, { min_span: ms, trend_mode: 'flip', max_span: mx });
    const r = s11Violations(ev);
    assert(r.chk > 0, `some BOS checked (msp${ms} mx${mx})`);
    eq(r.v, 0, `§1-1 violations msp${ms} mx${mx}: ${r.v}`);
  }
});

// GT match scorer: greedy 1:1 requiring SAME type + SAME direction + level ≤6.
// Direction matters — an earlier direction-blind version overcounted badly (it
// matched a bear BOS to the user's bull BOS). `dir` from the GT fixture is the
// broken-pivot's high/low side. NOTE: this is type+dir+level only (no time
// window); a stricter ±6-bar pivot-time gate drops a few more that are just
// pivot-bar assignment noise — kept out so the metric tracks structure, not timing.
function gtScore(ev, gt) {
  let lvl = 0, stt = 0; const used = new Set();
  for (const g of gt) {
    let best = -1;
    ev.forEach((e, i) => { if (used.has(i) || best >= 0) return; if (e.type === g.type && e.direction === g.direction && Math.abs(e.level - g.level) <= 6) best = i; });
    if (best >= 0) { lvl++; used.add(best); if (ev[best].state === g.state) stt++; }
  }
  return { lvl, stt };
}

test('flip mode beats backbone on the 05/13 ground truth [regression guard]', () => {
  let bars, gt;
  try { bars = require('../test_data/bars15_0513.json'); gt = require('../test_data/ground_truth_0513_15m.json'); }
  catch (e) { console.log('      (skipped — fixtures not present)'); return; }
  const flip = gtScore(S.detectSpanEvents(bars, { min_span: 2, trend_mode: 'flip', max_span: 10 }), gt);
  const bb   = gtScore(S.detectSpanEvents(bars, { min_span: 4, trend_mode: 'backbone', backbone_strength: 3, max_span: 100 }), gt);
  console.log(`      [type+dir+level] flip msp2/mx10: ${flip.lvl}/${gt.length} matched, ${flip.stt} state correct | backbone: ${bb.lvl}/${gt.length} matched, ${bb.stt} state`);
  // Honest baseline (2026-06): flip reproduces 10/17 of the hand drawing with
  // correct type+direction+level and 9/17 with the right O/X state. The rest is
  // open decomposition work (legs eaten by stage-2 merge, a type mismatch). Lock
  // BOTH floors — state accuracy is the meaningful metric (matched count alone can
  // be inflated by X events landing on O labels).
  assert(flip.lvl >= 10, `flip should match ≥10/${gt.length} (got ${flip.lvl})`);
  assert(flip.stt >= 8,  `flip should get ≥8/${gt.length} states right (got ${flip.stt})`);
  assert(flip.stt > bb.stt, `flip state (${flip.stt}) should beat backbone state (${bb.stt})`);
});

console.log(`\n=== Result: ${_n - _f}/${_n} passed ===`);
if (_f) process.exit(1);
