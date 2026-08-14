/**
 * Acceptance test harness for sim_engine.js.
 *
 * Run from chart_viewer/static/ with:
 *   node test_sim_engine.js
 *
 * Covers the four order types (market / limit / stop / stop_limit), the
 * bracket + OCO mechanics, MAE / MFE tracking, cancel cascading, and
 * commission accumulation. UI integration tests live elsewhere — this
 * file is engine-only so it can run under Node without a browser.
 *
 * Style follows test_position_calc.js: tiny window shim, sequential
 * tests printing PASS/FAIL, exit code = number of failures.
 */

global.window = {};
require('./symbol_specs.js');
require('./sim_engine.js');

const SymbolSpecs = global.window.SymbolSpecs;
const SimEngine   = global.window.SimEngine;

const NQ = SymbolSpecs.getSpec('NQ');
// NQ contract: pointValue=20, lotSize=1, tickSize=0.25, qtyStep=1,
//              spread=0.25, slippageTicks=1, commissionPerSide=$0.50.
// half-spread = 0.125, slip = 1·0.25 = 0.25.
//
// Market fills land at bar.close ± half-spread (replay-frozen-time
// semantic per spec § Order types). All "expected fill" math below
// uses close, NOT open.

// ----- Tiny test framework -----

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? '  → ' + detail : ''}`);
  }
}
function approxEq(a, b, eps) {
  if (eps == null) eps = 1e-6;
  return Math.abs(a - b) <= eps;
}

// ----- Bar factory: timestamps in 1-min increments from 0 -----

let _ts = 0;
function bar(open, high, low, close) {
  _ts += 60_000;
  return { timestamp: _ts, open, high, low, close, volume: 1 };
}
function freshEngine(accountSize) {
  // Reset module-level ID counters so test diagnostics are readable
  // (order #1, position #1) instead of "order #142 from a leaked prior run".
  SimEngine._resetIdCounters();
  _ts = 0;
  return SimEngine.create({ spec: NQ, accountSize: accountSize || 50000 });
}

// =================================================================
// 1. Market buy fills at bar.close + half-spread
// =================================================================
{
  const e = freshEngine();
  e.placeOrder({ side: 'buy', type: 'market', qty: 1 });
  const fills = e.processBar(bar(26500, 26510, 26490, 26505));
  // close = 26505 → fill = 26505 + 0.125 = 26505.125
  check('1.market.buy.fills',
    fills.length === 1 && fills[0].fillPrice === 26505 + 0.125,
    `fillPrice=${fills[0] && fills[0].fillPrice} expected ${26505.125}`);
  const pos = e.getPositions()[0];
  check('1.market.buy.opens.long',
    pos && pos.side === 'long' && pos.qty === 1 && pos.avgEntryPrice === 26505.125);
  check('1.market.buy.commission',
    pos && pos.commissionPaid === 0.50,
    `commission=${pos && pos.commissionPaid}`);
  check('1.market.buy.balance.debited',
    e.getAccount().balance === 50000 - 0.50,
    `balance=${e.getAccount().balance}`);
}

// =================================================================
// 2. Market sell fills at bar.close - half-spread
// =================================================================
{
  const e = freshEngine();
  e.placeOrder({ side: 'sell', type: 'market', qty: 1 });
  const fills = e.processBar(bar(26500, 26510, 26490, 26505));
  // close = 26505 → fill = 26505 - 0.125 = 26504.875
  check('2.market.sell.fills.below.close',
    fills.length === 1 && fills[0].fillPrice === 26505 - 0.125,
    `fillPrice=${fills[0] && fills[0].fillPrice}`);
  const pos = e.getPositions()[0];
  check('2.market.sell.opens.short',
    pos && pos.side === 'short' && pos.qty === 1);
}

// =================================================================
// 3. Limit buy fills on a DOWN bar where the limit is in range
// =================================================================
{
  const e = freshEngine();
  e.placeOrder({ side: 'buy', type: 'limit', qty: 1, price: 26450 });
  // Down bar: open 26500, dipped to 26440 (touches limit 26450), closes 26460
  const fills = e.processBar(bar(26500, 26510, 26440, 26460));
  check('3.limit.buy.fills.on.down.bar',
    fills.length === 1 && fills[0].fillPrice === 26450,
    `fillPrice=${fills[0] && fills[0].fillPrice}`);
  check('3.limit.buy.no.slippage',
    fills.length === 1 && fills[0].fillPrice === 26450,
    'limits should not slip — that is the whole point');
}

// =================================================================
// 4. Limit buy fills as soon as the bar's wick reaches the limit price,
//    REGARDLESS of overall bar direction. Real-market behavior — at
//    some point during the bar, price was at-or-below the limit, so
//    the order would have executed there.
//    (Earlier the engine required a down-bar; that "moving toward"
//    gate was removed per user spec — see _limitMatches.)
// =================================================================
{
  const e = freshEngine();
  e.placeOrder({ side: 'buy', type: 'limit', qty: 1, price: 26450 });
  // Up bar with a long lower wick that touches limit:
  // open 26460, low 26440 (wick crosses 26450), close 26500
  const fills = e.processBar(bar(26460, 26510, 26440, 26500));
  check('4.limit.buy.fills.on.wick.cross.regardless.of.bar.direction',
    fills.length === 1 && fills[0].fillPrice === 26450,
    `fills=${fills.length} fillPrice=${fills[0] && fills[0].fillPrice}`);
  check('4.limit.buy.removed.from.pending',
    e.getPendingOrders().length === 0);
}

// =================================================================
// 4b. Limit placed AFTER a bar has been processed defers fill until
//     the NEXT bar — even when the just-processed bar's range
//     trivially crosses the limit price. Mirrors the replay-mode
//     workflow where the user picks a cursor (engine ticks once),
//     then places a limit; the user expects to see the pending line
//     and decide whether to wait or adjust before fill.
// =================================================================
{
  const e = freshEngine();
  // Step 1: process a bar — establishes state.lastBar so the next
  // placeOrder timestamps the order with this bar's ts.
  const b1 = bar(26450, 26460, 26440, 26455);
  e.processBar(b1);
  // Step 2: place a buy limit AT a price the just-processed bar
  // already crosses. createdAtBarTs == b1.timestamp.
  e.placeOrder({ side: 'buy', type: 'limit', qty: 1, price: 26450 });
  // Step 3: simulate _tickNow re-running processBar on the same bar.
  // Defer rule: createdAtBarTs == bar.timestamp → SKIP. No fill.
  const fillsSameBar = e.processBar(b1);
  check('4b.limit.defers.on.same.bar.as.placement',
    fillsSameBar.length === 0,
    `unexpected fills on placement bar=${fillsSameBar.length}`);
  check('4b.limit.still.pending.after.placement.bar',
    e.getPendingOrders().length === 1);
  // Step 4: advance to a fresh bar — defer rule no longer applies.
  // Bar's wick covers limit → fill at limit price.
  const fillsNextBar = e.processBar(bar(26452, 26462, 26445, 26458));
  check('4b.limit.fills.on.next.bar',
    fillsNextBar.length === 1 && fillsNextBar[0].fillPrice === 26450,
    `fills=${fillsNextBar.length} fillPrice=${fillsNextBar[0] && fillsNextBar[0].fillPrice}`);
}

// =================================================================
// 4c. FIRST-EVER limit (no prior processBar) ALSO defers when the
//     caller passes `atBarTs` — closes the gap where state.lastBar
//     was null on initial replay-mode placement, which previously
//     bypassed the defer and let the limit fill instantly like a
//     market order. SimController.placeOrder forwards atBarTs.
// =================================================================
{
  const e = freshEngine();
  const tsX = 1700_000_000_000;
  // First-ever order — no prior processBar. Caller hints atBarTs.
  e.placeOrder({ side: 'buy', type: 'limit', qty: 1, price: 26450,
                 atBarTs: tsX });
  const sameBar = { timestamp: tsX, open: 26450, high: 26460, low: 26440, close: 26455, volume: 100 };
  const fills1 = e.processBar(sameBar);
  check('4c.first.limit.defers.via.atBarTs',
    fills1.length === 0,
    `unexpected fills=${fills1.length} (first limit should defer when atBarTs is provided)`);
  // Next bar (fresh ts) — defer no longer applies.
  const nextBar = { timestamp: tsX + 60_000, open: 26452, high: 26460, low: 26445, close: 26458, volume: 100 };
  const fills2 = e.processBar(nextBar);
  check('4c.first.limit.fills.on.subsequent.bar',
    fills2.length === 1 && fills2[0].fillPrice === 26450);
}

// =================================================================
// 4d. Bracket children (limits / stops with bracketParentId) are
//     EXEMPT from the same-bar defer — they need to fire same-bar
//     when conditions are already met at confirm-time so the user's
//     just-sealed bracket honors price action that already happened.
// =================================================================
{
  const e = freshEngine();
  // Simulate a long position already filled at 100. Now manually
  // place a TP child at 99 (below current) on the same bar — the
  // child should fire same-bar because bar.low ≤ 99.
  const tsX = 1700_000_000_000;
  // Stand-in entry order (we don't actually need to fill it for
  // testing the child's defer behavior — the child just needs
  // bracketParentId set).
  const parentId = e.placeOrder({ side: 'buy', type: 'market', qty: 1, atBarTs: tsX });
  // Process bar to fill market entry.
  const sameBar = { timestamp: tsX, open: 100, high: 102, low: 98, close: 101, volume: 100 };
  e.processBar(sameBar);
  // Now place a sell limit (TP) child at 99 — already in range
  // (bar.high 102 ≥ 99). With bracket exemption, fires same-bar.
  const childId = e.placeOrder({
    side: 'sell', type: 'limit', qty: 1, price: 99,
    bracketParentId: parentId, atBarTs: tsX,
  });
  // Manually arm the child (mimics _confirmProposal's behavior since
  // the parent already filled).
  const child = e.getOrder(childId);
  if (child) child.active = true;
  // Re-tick the same bar — the bracket child should fire because the
  // exemption says fresh-on-same-bar AND has bracketParentId → don't defer.
  const fills = e.processBar(sameBar);
  check('4d.bracket.child.fires.same.bar.as.confirm',
    fills.length === 1 && fills[0].id === childId,
    `fills=${fills.length} firstId=${fills[0] && fills[0].id} expected childId=${childId}`);
}

// =================================================================
// 5. Limit sell fills on an UP bar where the limit is in range
// =================================================================
{
  const e = freshEngine();
  e.placeOrder({ side: 'sell', type: 'limit', qty: 1, price: 26550 });
  // Up bar: open 26500, high 26560 (touches), close 26545
  const fills = e.processBar(bar(26500, 26560, 26490, 26545));
  check('5.limit.sell.fills.on.up.bar',
    fills.length === 1 && fills[0].fillPrice === 26550);
}

// =================================================================
// 6. Stop buy fills at stopPrice + slippage when bar's high crosses stop
// =================================================================
{
  const e = freshEngine();
  e.placeOrder({ side: 'buy', type: 'stop', qty: 1, stopPrice: 26550 });
  const fills = e.processBar(bar(26500, 26560, 26490, 26540));
  check('6.stop.buy.fills',
    fills.length === 1 && fills[0].fillPrice === 26550.25,
    `fillPrice=${fills[0] && fills[0].fillPrice} expected 26550.25`);
}

// =================================================================
// 7. Stop sell fills at stopPrice - slippage when bar's low crosses stop
// =================================================================
{
  const e = freshEngine();
  e.placeOrder({ side: 'sell', type: 'stop', qty: 1, stopPrice: 26450 });
  const fills = e.processBar(bar(26500, 26510, 26440, 26460));
  check('7.stop.sell.fills',
    fills.length === 1 && fills[0].fillPrice === 26449.75,
    `fillPrice=${fills[0] && fills[0].fillPrice} expected 26449.75`);
}

// =================================================================
// 8. Stop_limit triggers AND fills on the same bar if the post-trigger
//    limit price is in the bar's range (under the new wick-cross rule).
//    Buy stop_limit: stop fires when high >= stopPrice, then it converts
//    to a limit order that fills if bar.low <= limitPrice (which is
//    typically true on the same trigger bar since limit ≥ stop).
// =================================================================
{
  const e = freshEngine();
  // Buy stop at 26550 → if triggered, limit-in at 26555.
  e.placeOrder({ side: 'buy', type: 'stop_limit', qty: 1,
                 stopPrice: 26550, price: 26555 });
  // Bar crosses stop AND covers the limit: high 26560 (≥ stop 26550),
  // low 26545 (≤ limit 26555). Pass 2 (stops) converts to limit.
  // Pass 3 (limits) sees bar.low ≤ 26555 → fill on same bar.
  const fills = e.processBar(bar(26545, 26560, 26545, 26555));
  check('8.stop_limit.fills.on.trigger.bar.when.in.range',
    fills.length === 1 && fills[0].fillPrice === 26555,
    `fills=${fills.length} fillPrice=${fills[0] && fills[0].fillPrice}`);
  // Order should be settled, not pending.
  check('8.stop_limit.removed.from.pending.after.fill',
    e.getPendingOrders().length === 0);
}

// =================================================================
// 9. Stop_limit fills on a LATER bar when the trigger bar's range is
//    entirely above the post-trigger limit. Buy stop_limit: stop fires
//    when high ≥ stopPrice; once converted, limit fills only when a
//    subsequent bar's low reaches down to the limit price.
// =================================================================
{
  const e = freshEngine();
  // Buy stop at 26550, post-trigger limit at 26555 (typical small buffer).
  e.placeOrder({ side: 'buy', type: 'stop_limit', qty: 1,
                 stopPrice: 26550, price: 26555 });
  // Trigger bar fully ABOVE limit: open 26560, high 26565, low 26556,
  // close 26562. high (26565) ≥ stop (26550) → triggers. bar.low
  // (26556) > limit (26555) → does NOT fill on the trigger bar.
  const fills1 = e.processBar(bar(26560, 26565, 26556, 26562));
  check('9.stop_limit.no.fill.on.trigger.bar.when.limit.below.bar.low',
    fills1.length === 0,
    `unexpected fills1=${fills1.length}`);
  // Order has converted to plain limit, still pending.
  const pending = e.getPendingOrders();
  check('9.stop_limit.converted.to.limit',
    pending.length === 1
      && pending[0].type === 'limit'
      && pending[0].triggeredAt != null);
  // Later bar's low dips to / below limit: low 26553 ≤ 26555 → fills.
  const fills2 = e.processBar(bar(26565, 26565, 26553, 26554));
  check('9.stop_limit.fills.on.later.bar.when.wick.crosses.limit',
    fills2.length === 1 && fills2[0].fillPrice === 26555,
    `fills2=${fills2.length} fillPrice=${fills2[0] && fills2[0].fillPrice}`);
}

// =================================================================
// 10. Bracket TP hit closes position, reason = 'tp_hit', SL cancelled
// =================================================================
{
  const e = freshEngine();
  // Market buy + TP at 26550, SL at 26480.
  e.placeBracket({
    entry: { side: 'buy', type: 'market', qty: 1 },
    takeProfit: 26550,
    stopLoss: 26480,
    setupTag: 'BO retest',
  });
  // Bar 1: market fills at close=26505 + 0.125 = 26505.125. Neither
  // TP nor SL in range.
  e.processBar(bar(26500, 26510, 26495, 26505));
  check('10.bracket.entry.filled',
    e.getPositions().length === 1
      && e.getPositions()[0].side === 'long'
      && e.getPositions()[0].avgEntryPrice === 26505.125);
  // The two children should now be active and pending.
  const pendingAfterEntry = e.getPendingOrders();
  check('10.bracket.children.armed',
    pendingAfterEntry.length === 2 && pendingAfterEntry.every(o => o.active));

  // Bar 2: up-bar that hits TP. open 26505, high 26555 (covers TP=26550),
  // close 26550. Sell-limit on an up bar → fills.
  e.processBar(bar(26505, 26555, 26500, 26550));
  const closed = e.getPositionHistory()[0];
  check('10.bracket.tp.closes.position',
    e.getPositions().length === 0 && closed && closed.closeReason === 'tp_hit');
  // Realised = (26550 - 26505.125) × 1 × 20 = 44.875 × 20 = 897.50
  check('10.bracket.tp.realised',
    closed && approxEq(closed.realisedPnL, 897.50, 1e-6),
    `realisedPnL=${closed && closed.realisedPnL}`);
  // SL must have been auto-cancelled by OCO.
  const slOrder = e.getOrderHistory().find(o => o.type === 'stop');
  check('10.bracket.sl.cancelled.by.oco',
    slOrder && slOrder.status === 'cancelled');
}

// =================================================================
// 11. Bracket SL hit closes position with loss, TP cancelled by OCO
// =================================================================
{
  const e = freshEngine();
  e.placeBracket({
    entry: { side: 'buy', type: 'market', qty: 1 },
    takeProfit: 26550,
    stopLoss:   26480,
  });
  e.processBar(bar(26500, 26510, 26495, 26505));   // market fills at close=26505 + 0.125 = 26505.125
  // Bar that hits SL: low 26475 (covers stop 26480). Stop fills at 26480 - 0.25 = 26479.75.
  e.processBar(bar(26505, 26510, 26475, 26485));
  const closed = e.getPositionHistory()[0];
  check('11.bracket.sl.closes.position',
    e.getPositions().length === 0 && closed && closed.closeReason === 'sl_hit');
  // Realised = (26479.75 - 26505.125) × 1 × 20 = -25.375 × 20 = -507.50
  check('11.bracket.sl.realised.loss',
    closed && approxEq(closed.realisedPnL, -507.50, 1e-6),
    `realisedPnL=${closed && closed.realisedPnL}`);
  const tpOrder = e.getOrderHistory().find(o => o.type === 'limit');
  check('11.bracket.tp.cancelled.by.oco',
    tpOrder && tpOrder.status === 'cancelled');
}

// =================================================================
// 12. MAE / MFE update across multiple bars
// =================================================================
{
  const e = freshEngine();
  e.placeOrder({ side: 'buy', type: 'market', qty: 1 });
  // Entry bar: market fills at close=26505 + 0.125 = 26505.125.
  e.processBar(bar(26500, 26510, 26495, 26505));
  // Bar: high 26515, low 26495.
  //   MFE so far = (26515 - 26505.125) × 1 × 20 = 197.50
  //   MAE so far = (26495 - 26505.125) × 1 × 20 = -202.50
  e.processBar(bar(26505, 26515, 26495, 26510));
  let pos = e.getPositions()[0];
  check('12.mfe.first.bar', approxEq(pos.mfe, 197.50, 1e-6),
    `mfe=${pos.mfe}`);
  check('12.mae.first.bar', approxEq(pos.mae, -202.50, 1e-6),
    `mae=${pos.mae}`);
  // Bar: high 26530, low 26500. New MFE = (26530-26505.125)*20 = 497.50.
  // MAE doesn't worsen (low 26500 > previous trough 26495).
  e.processBar(bar(26510, 26530, 26500, 26520));
  pos = e.getPositions()[0];
  check('12.mfe.expands', approxEq(pos.mfe, 497.50, 1e-6));
  check('12.mae.preserved', approxEq(pos.mae, -202.50, 1e-6));
  // Bar: low 26485 (worse than -202.50 trough). New MAE = (26485-26505.125)*20 = -402.50.
  e.processBar(bar(26520, 26525, 26485, 26505));
  pos = e.getPositions()[0];
  check('12.mae.expands', approxEq(pos.mae, -402.50, 1e-6),
    `mae=${pos.mae}`);
  check('12.mfe.preserved.from.earlier', approxEq(pos.mfe, 497.50, 1e-6));
}

// =================================================================
// 13. Cancel pending order
// =================================================================
{
  const e = freshEngine();
  const id = e.placeOrder({ side: 'buy', type: 'limit', qty: 1, price: 26450 });
  const ok = e.cancelOrder(id);
  check('13.cancel.returns.true', ok);
  check('13.cancel.removes.from.pending',
    e.getPendingOrders().length === 0);
  const order = e.getOrder(id);
  check('13.cancel.flips.status', order && order.status === 'cancelled');
}

// =================================================================
// 14. Cancel parent → children cascade-cancelled
// =================================================================
{
  const e = freshEngine();
  const { entryId, tpId, slId } = e.placeBracket({
    entry: { side: 'buy', type: 'limit', qty: 1, price: 26450 },
    takeProfit: 26550,
    stopLoss:   26430,
  });
  e.cancelOrder(entryId);
  check('14.cancel.parent.removes.all.three',
    e.getPendingOrders().length === 0);
  check('14.cancel.parent.flips.tp.status',
    e.getOrder(tpId).status === 'cancelled');
  check('14.cancel.parent.flips.sl.status',
    e.getOrder(slId).status === 'cancelled');
}

// =================================================================
// 15. Commission accumulates per fill (entry + exit both pay)
// =================================================================
{
  const e = freshEngine(50000);
  e.placeBracket({
    entry: { side: 'buy', type: 'market', qty: 2 },
    takeProfit: 26550,
    stopLoss:   26480,
  });
  e.processBar(bar(26500, 26510, 26495, 26505));   // entry: 2 contracts × $0.50 = $1.00, fills at close=26505+0.125=26505.125
  e.processBar(bar(26505, 26555, 26500, 26550));   // TP fill: another $1.00
  const closed = e.getPositionHistory()[0];
  check('15.commission.entry.plus.exit',
    approxEq(closed.commissionPaid, 2.00, 1e-9),
    `commissionPaid=${closed.commissionPaid}`);
  // Account balance: 50000 + realised(qty=2) - commissions
  // realised = (26550 - 26505.125) × 2 × 20 = 44.875 × 40 = 1795.00
  // balance = 50000 + 1795 - 2 = 51793
  const acct = e.getAccount();
  check('15.balance.matches.realised.minus.commission',
    approxEq(acct.balance, 50000 + 1795.00 - 2.00, 1e-6),
    `balance=${acct.balance}`);
}

// =================================================================
// 16. Position averaging — same-side fills produce weighted avg entry
// =================================================================
{
  const e = freshEngine();
  e.placeOrder({ side: 'buy', type: 'market', qty: 1 });
  e.processBar(bar(26500, 26505, 26495, 26500));   // fills at 26500.125
  e.placeOrder({ side: 'buy', type: 'market', qty: 2 });
  e.processBar(bar(26510, 26515, 26505, 26510));   // fills at 26510.125
  const pos = e.getPositions()[0];
  // avg = (26500.125 × 1 + 26510.125 × 2) / 3 = 79530.375 / 3 = 26506.791666…
  check('16.position.qty.is.3', pos.qty === 3);
  check('16.position.avg.entry.weighted',
    approxEq(pos.avgEntryPrice, (26500.125 + 26510.125 * 2) / 3, 1e-9),
    `avg=${pos.avgEntryPrice}`);
}

// =================================================================
// 17. Multi-segment reduce-only bracket — TP1 closes 1 lot, SL clamps to
//     the runner, TP2 keeps guarding; then TP2 closes the runner.
// =================================================================
{
  const e = freshEngine();
  const { slIds, tpIds } = e.placeBracket({
    entry: { side: 'buy', type: 'market', qty: 2 },
    takeProfits: [{ price: 26550, qty: 1 }, { price: 26600, qty: 1 }],
    stopLosses:  [{ price: 26480, qty: 2 }],
  });
  e.processBar(bar(26500, 26505, 26495, 26500));   // entry: 2 lots @ 26500.125
  check('17.entry.qty.2', e.getPositions()[0].qty === 2);

  // Bar reaches TP1 (26550) but not TP2 (26600) and not SL (26480).
  e.processBar(bar(26505, 26550, 26505, 26545));
  const pos = e.getPositions()[0];
  check('17.tp1.closed.one.lot', pos && pos.qty === 1, `qty=${pos && pos.qty}`);
  check('17.sl.clamped.to.runner',
    e.getOrder(slIds[0]).qty === 1 && e.getOrder(slIds[0]).status === 'pending',
    `slQty=${e.getOrder(slIds[0]).qty}`);
  check('17.tp2.still.pending.qty1',
    e.getOrder(tpIds[1]).qty === 1 && e.getOrder(tpIds[1]).status === 'pending');

  // Bar reaches TP2 (26600) → closes the runner, SL cancelled.
  e.processBar(bar(26550, 26600, 26550, 26595));
  check('17.tp2.closes.runner', e.getPositions().length === 0);
  check('17.sl.cancelled.after.full.close',
    e.getOrder(slIds[0]).status === 'cancelled');
  const closed = e.getPositionHistory()[0];
  // realised = (26550-26500.125)*1*20 + (26600-26500.125)*1*20
  check('17.realised.both.tp.legs',
    approxEq(closed.realisedPnL, (26550 - 26500.125) * 20 + (26600 - 26500.125) * 20, 1e-6),
    `realised=${closed.realisedPnL}`);
}

// =================================================================
// 18. Multi-TP then SL on the runner — the clamped SL closes only the
//     remaining 1 lot (no over-close / no phantom flip), TP2 cancelled.
// =================================================================
{
  const e = freshEngine();
  const { tpIds } = e.placeBracket({
    entry: { side: 'buy', type: 'market', qty: 2 },
    takeProfits: [{ price: 26550, qty: 1 }, { price: 26600, qty: 1 }],
    stopLosses:  [{ price: 26480, qty: 2 }],
  });
  e.processBar(bar(26500, 26505, 26495, 26500));       // entry 2 lots
  e.processBar(bar(26505, 26550, 26505, 26545));       // TP1 → runner=1, SL clamps to 1
  check('18.after.tp1.qty.1', e.getPositions()[0].qty === 1);

  e.processBar(bar(26505, 26510, 26480, 26485));       // SL hit
  check('18.no.open.position', e.getPositions().length === 0);
  check('18.no.phantom.flip.short', e.getPositions().every(p => p.side !== 'short'));
  check('18.tp2.cancelled', e.getOrder(tpIds[1]).status === 'cancelled');
  const closed = e.getPositionHistory()[0];
  check('18.closed.qty.reflects.2.entered', closed.entryQty === 2);
  // realised = TP1 leg + SL leg (each 1 lot). SL fill = 26480 + sell slip(-0.25)=26479.75
  check('18.realised.tp1.plus.sl',
    approxEq(closed.realisedPnL,
      (26550 - 26500.125) * 20 + (26479.75 - 26500.125) * 20, 1e-6),
    `realised=${closed.realisedPnL}`);
}

// =================================================================
// Done.
// =================================================================
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
