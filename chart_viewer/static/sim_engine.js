/**
 * sim_engine.js — Order simulation engine for chart_viewer.
 *
 * Pure logic: takes orders + bars, returns fills + position state. NO UI,
 * NO chart code, NO storage. The on-chart overlay (sim_overlays.js), the
 * right-side trading panel (sim_panel.js), and the trade history table
 * (sim_history.js) all sit on top of this engine.
 *
 * Spec: docs/specs/trade-simulation-spec.md (§"Simulation engine")
 *
 * Order types:
 *   - market     : fills at the next bar's open ± half-spread
 *   - limit      : fills if `bar.low ≤ limit ≤ bar.high` AND the bar's
 *                  open→close direction is "moving toward limit" (buy
 *                  limit needs a down bar, sell limit needs an up bar)
 *   - stop       : trigger when bar's range crosses the stop. Fills as
 *                  market at `stopPrice ± slippageTicks·tickSize`.
 *   - stop_limit : stop-trigger logic, then becomes a limit order at
 *                  `limitPrice`. May not fill on the trigger bar.
 *
 * Brackets: a parent entry can carry two children (TP = limit on opposite
 * side, SL = stop on opposite side). Children stay `active=false` until
 * the parent fills, then arm. Children are linked OCO via
 * `ocoSiblingId` — when one fills, the other is cancelled.
 *
 * MAE / MFE: tracked per open position on every bar. MAE = worst (most
 * negative) unrealised P/L during hold; MFE = best.
 *
 * Commission: deducted from balance on EVERY fill (entry + exit, both
 * sides). The position's `realisedPnL` field is GROSS (pre-commission);
 * `commissionPaid` is tracked separately so the history table can show
 * gross + net.
 *
 * Conventions matched from position_calc.js:
 *   - IIFE + window.SimEngine exposure
 *   - `window.SimEngine.create({ spec, accountSize, startingBalance? })`
 *     returns an instance with the methods listed below
 *   - All P/L uses `qty × points × pointValue × lotSize` (no per-unit
 *     shortcuts — explicitly the bug position_calc.js was avoiding)
 */
(function () {
  // Module-level monotonic counters so order / position IDs stay unique
  // across multiple engine instances (helps when the host might create
  // a second engine for what-if forks later).
  let _nextOrderId = 1;
  let _nextPositionId = 1;

  function create(opts) {
    const spec = opts && opts.spec ? opts.spec : {};
    const accountSize = (opts && opts.accountSize) || 50000;
    const startingBalance = (opts && opts.startingBalance != null)
      ? opts.startingBalance
      : accountSize;

    // Mutable engine state captured in this closure. Tests read it via
    // the getter methods on the returned object.
    const state = {
      spec,
      accountSize,
      startingBalance,
      balance: startingBalance,
      pendingOrders: [],     // SimOrder[]   — type === 'pending'
      orderHistory: [],      // SimOrder[]   — every order ever (incl. pending)
      positions: [],         // SimPosition[] — currently open
      positionHistory: [],   // SimPosition[] — closed
      lastBar: null,         // {timestamp, open, high, low, close}
    };

    // ----- Helpers (reach into state via closure, not parameters) -----

    const halfSpread     = () => (spec.spread || 0) / 2;
    const tickSize       = () => spec.tickSize || 0.01;
    const slippagePts    = () => (spec.slippageTicks || 0) * tickSize();
    const pointValue     = () => spec.pointValue || 1;
    const lotMultiplier  = () => spec.lotSize || 1;
    const commissionPer  = () => spec.commissionPerSide || 0;

    // PnL formula from position_calc.js:
    //   pnl = (exit - entry) × qty × dir × pointValue × lotSize
    function pnlInUSD(side, entryPx, exitPx, qty) {
      const dir = side === 'long' ? 1 : -1;
      return (exitPx - entryPx) * qty * dir * pointValue() * lotMultiplier();
    }

    // ----- Public API: order placement, cancel, modify -----

    function placeOrder(args) {
      const order = makeOrder(args);
      state.pendingOrders.push(order);
      state.orderHistory.push(order);
      return order.id;
    }

    function makeOrder(args) {
      if (!args) throw new Error('sim_engine: placeOrder needs args');
      if (args.side !== 'buy' && args.side !== 'sell') {
        throw new Error('sim_engine: side must be "buy" or "sell"');
      }
      if (!['market', 'limit', 'stop', 'stop_limit'].includes(args.type)) {
        throw new Error(`sim_engine: unknown order type ${args.type}`);
      }
      if (!(args.qty > 0)) throw new Error('sim_engine: qty must be > 0');

      // Type-specific required fields
      if ((args.type === 'limit' || args.type === 'stop_limit')
          && !Number.isFinite(args.price)) {
        throw new Error(`sim_engine: ${args.type} order needs price`);
      }
      if ((args.type === 'stop' || args.type === 'stop_limit')
          && !Number.isFinite(args.stopPrice)) {
        throw new Error(`sim_engine: ${args.type} order needs stopPrice`);
      }
      // Bracket children start inactive (the parent fill arms them).
      const isChild = !!args.bracketParentId;
      // createdAtBarTs source priority:
      //   1. caller-provided `atBarTs` (SimController.placeOrder forwards
      //      the cursor's current bar timestamp — required so the FIRST
      //      ever order in replay/sim has a valid bar context, otherwise
      //      `state.lastBar` is still null pre-first-tick and the
      //      same-bar-defer rule for limits would fail to apply)
      //   2. state.lastBar.timestamp (most recently processed bar)
      //   3. null (test-only path; defer check naturally skips)
      const atBarTs = (args.atBarTs != null) ? args.atBarTs
        : (state.lastBar ? state.lastBar.timestamp : null);
      return {
        id: _nextOrderId++,
        side: args.side,
        type: args.type,
        qty: args.qty,
        // Generic price field — for limit it's the limit price, for
        // stop_limit it's the post-trigger limit, unused for market/stop.
        price: args.price != null ? args.price : null,
        stopPrice: args.stopPrice != null ? args.stopPrice : null,
        // After a stop_limit triggers, this is set so the matcher knows
        // the original stop price (for history / display).
        triggeredAt: null,
        status: 'pending',
        active: !isChild,
        createdAtBarTs: atBarTs,
        filledAtBarTs: null,
        fillPrice: null,
        bracketParentId: args.bracketParentId || null,
        ocoSiblingId: args.ocoSiblingId || null,
        setupTag: args.setupTag || null,
        // branching-replay-spec §7.5: every order is tagged with the
        // branch it was placed on. Caller (SimController) reads
        // BranchEngine.activeBranchId and forwards it. Resulting
        // positions inherit this from their entry order. Defaulted to
        // 'main' so engine remains usable even if BranchEngine isn't
        // loaded (e.g. older code paths or tests).
        branchId: args.branchId || 'main',
        // Set true by Controller.closeAndReverse — a market order sized
        // to cross zero (qty = pos.qty * 2) so the engine's existing
        // flip logic closes the old position AND opens the reversed
        // one in a single fill. _deriveCloseReason reads this to mark
        // the old position with closeReason='reverse' instead of
        // 'manual', and the trade-history table can render it as a
        // distinct entry type.
        isReverse: !!args.isReverse,
        // Filled in by `_settle` so the history table can reproduce the
        // gross / net split without re-deriving commission later.
        commission: 0,
      };
    }

    /**
     * Place an entry + bracket (TP, SL) atomically. Returns the entry's
     * order id; the children are linked via bracketParentId + OCO and
     * arm only when entry fills.
     *
     *   placeBracket({
     *     entry: { side, type, qty, price?, stopPrice? },
     *     takeProfit: <price>,    // optional single TP (opposite-side limit, full qty)
     *     stopLoss:   <price>,    // optional single SL (opposite-side stop,  full qty)
     *     // OR multi-segment (reduce-only, e.g. "close 1 lot at TP1, run the
     *     // rest to TP2; SL covers whatever is still open"):
     *     takeProfits: [{ price, qty }, …],   // each closes `qty` of the position
     *     stopLosses:  [{ price, qty }, …],   // usually one leg sized to full qty
     *     setupTag:   '...',      // stamped on entry + position
     *   })
     *
     * Multi-segment legs are NOT OCO-paired — they form a REDUCE-ONLY group:
     * each fill shrinks the position and the surviving legs clamp down to the
     * still-open qty (see _reconcileExitLegs), so the runner keeps its SL / next
     * TP alive at the right size instead of needing a manual re-draw. A legacy
     * single TP + single SL keeps its exact 1:1 OCO behaviour.
     */
    function placeBracket(args) {
      if (!args || !args.entry) throw new Error('placeBracket needs args.entry');
      const e = args.entry;
      const entryId = placeOrder({
        ...e, setupTag: args.setupTag,
        branchId: args.branchId || e.branchId,
      });
      const oppSide = e.side === 'buy' ? 'sell' : 'buy';

      // Normalise TP/SL into segment lists. Scalar → one full-qty segment.
      const tpSegs = Array.isArray(args.takeProfits) ? args.takeProfits
        : (Number.isFinite(args.takeProfit) ? [{ price: args.takeProfit, qty: e.qty }] : []);
      const slSegs = Array.isArray(args.stopLosses) ? args.stopLosses
        : (Number.isFinite(args.stopLoss) ? [{ price: args.stopLoss, qty: e.qty }] : []);
      const usedArrays = Array.isArray(args.takeProfits) || Array.isArray(args.stopLosses);

      const legOpts = (extra, seg) => ({
        side: oppSide, qty: (seg.qty > 0 ? seg.qty : e.qty),
        bracketParentId: entryId, setupTag: args.setupTag,
        branchId: args.branchId || e.branchId, ...extra,
      });
      const tpIds = [], slIds = [];
      for (const seg of tpSegs) {
        if (!Number.isFinite(seg.price)) continue;
        tpIds.push(placeOrder(legOpts({ type: 'limit', price: seg.price }, seg)));
      }
      for (const seg of slSegs) {
        if (!Number.isFinite(seg.price)) continue;
        slIds.push(placeOrder(legOpts({ type: 'stop', stopPrice: seg.price }, seg)));
      }

      // Legacy single-TP + single-SL keeps the exact 1:1 OCO pairing.
      // Multi-segment groups intentionally skip OCO and rely on the reduce-only
      // reconcile + dangling-cancel instead.
      if (!usedArrays && tpIds.length === 1 && slIds.length === 1) {
        const tp = state.orderHistory.find(o => o.id === tpIds[0]);
        const sl = state.orderHistory.find(o => o.id === slIds[0]);
        if (tp) tp.ocoSiblingId = slIds[0];
        if (sl) sl.ocoSiblingId = tpIds[0];
      }
      return { entryId, tpId: tpIds[0] || null, slId: slIds[0] || null, tpIds, slIds };
    }

    function cancelOrder(id) {
      const order = state.orderHistory.find(o => o.id === id);
      if (!order || order.status !== 'pending') return false;
      order.status = 'cancelled';
      state.pendingOrders = state.pendingOrders.filter(o => o.id !== id);
      // Cascading: if this order was a bracket parent, its children are
      // now orphaned — cancel them too (they can never arm).
      const children = state.orderHistory.filter(
        o => o.bracketParentId === id && o.status === 'pending');
      for (const c of children) {
        c.status = 'cancelled';
        state.pendingOrders = state.pendingOrders.filter(o => o.id !== c.id);
      }
      return true;
    }

    function modifyOrder(id, changes) {
      const order = state.pendingOrders.find(o => o.id === id);
      if (!order) return false;
      if (changes.price      !== undefined) order.price      = changes.price;
      if (changes.stopPrice  !== undefined) order.stopPrice  = changes.stopPrice;
      if (changes.qty        !== undefined && changes.qty > 0) order.qty = changes.qty;
      return true;
    }

    // ----- Main loop: process one bar / sub-bar -----

    function processBar(bar) {
      if (!bar || !Number.isFinite(bar.timestamp)) {
        throw new Error('sim_engine: processBar needs bar with timestamp');
      }
      const fills = [];

      // Pass 1: market orders fill at bar.CLOSE ± half-spread.
      //
      // Replay-frozen-time semantic (per spec § Order types): when the
      // user clicks the panel's market CTA the simulator is paused at
      // the cursor's bar — there is no "next tick" to wait for. Filling
      // at bar.close matches the user's mental model "I clicked at this
      // price, fill me at this price". A real broker would route at the
      // next tick, but the difference is negligible at 1m–15m playback.
      //
      // We snapshot pendingOrders into a local array because fillOrder
      // mutates state.pendingOrders mid-iteration.
      for (const order of state.pendingOrders.slice()) {
        if (order.status !== 'pending' || !order.active) continue;
        if (order.type !== 'market') continue;
        const fillPrice = bar.close
          + (order.side === 'buy' ? +halfSpread() : -halfSpread());
        _fillOrder(order, fillPrice, bar);
        fills.push(order);
      }

      // Pass 2: stop triggers (some fill as market, some convert to limit).
      // A bracket child stop that just got armed by pass-1 fill is also
      // included — that's intended; in real markets a stop-loss can hit
      // on the same bar as a market entry.
      for (const order of state.pendingOrders.slice()) {
        if (order.status !== 'pending' || !order.active) continue;
        if (order.type !== 'stop' && order.type !== 'stop_limit') continue;
        if (!_stopTriggered(order, bar)) continue;
        if (order.type === 'stop') {
          const slip = order.side === 'buy' ? +slippagePts() : -slippagePts();
          const fillPrice = order.stopPrice + slip;
          _fillOrder(order, fillPrice, bar);
          fills.push(order);
        } else {
          // stop_limit: convert in-place to a limit at order.price.
          // The pass-3 limit matcher will pick it up below if its limit
          // condition is satisfied on this same bar; otherwise it stays
          // pending for future bars (the spec calls this out explicitly:
          // "may not fill on the trigger bar").
          order.triggeredAt = bar.timestamp;
          order.type = 'limit';
        }
      }

      // Pass 3: limit orders. Includes the stop_limits that converted
      // in pass 2, so a tight stop_limit can fill within the same bar.
      //
      // BUT — top-level limits placed during this same bar (their
      // createdAtBarTs equals this bar's timestamp) are deferred to
      // the NEXT bar. Without this, placing a limit at-or-near the
      // current price fills instantly on the same tick and the user
      // never sees the pending line.
      //
      // Defer is SKIPPED for:
      //   - converted stop_limits (`triggeredAt` set during pass 2)
      //   - bracket children (`bracketParentId` set) — TP/SL legs
      //     need to fire same-bar to honor the user's just-confirmed
      //     bracket if price is already through the level
      //
      // In replay sub-bar mode, the cursor display bar's timestamp
      // stays constant across all sub-ticks within one display bar,
      // so the defer holds for the entire display-bar period — the
      // user gets a full bar to see the pending line and adjust before
      // the limit becomes eligible to fill on the next bar.
      for (const order of state.pendingOrders.slice()) {
        if (order.status !== 'pending' || !order.active) continue;
        if (order.type !== 'limit') continue;
        const isFreshTopLevelLimit = order.createdAtBarTs === bar.timestamp
          && !order.triggeredAt
          && !order.bracketParentId;
        if (isFreshTopLevelLimit) continue;
        if (!_limitMatches(order, bar)) continue;
        _fillOrder(order, order.price, bar);
        fills.push(order);
      }

      // Update unrealised P/L + MAE/MFE for every still-open position.
      for (const pos of state.positions) _updateExtremes(pos, bar);

      state.lastBar = bar;
      return fills;
    }

    /** Sub-bar processing is the same logic as processBar — the only
     *  difference is the granularity of `bar` (1m vs display-TF). The
     *  host (replay.js) decides which to call. */
    function processSubBar(subBar) {
      return processBar(subBar);
    }

    // ----- Order matching predicates -----

    function _stopTriggered(order, bar) {
      // Buy stop: triggers when price RISES to stopPrice.
      // Sell stop: triggers when price FALLS to stopPrice.
      if (order.side === 'buy')  return bar.high >= order.stopPrice;
      if (order.side === 'sell') return bar.low  <= order.stopPrice;
      return false;
    }

    function _limitMatches(order, bar) {
      // User-confirmed real-market behavior:
      //   - Buy limit at L fills as soon as bar.low ≤ L. If the latest
      //     market price is already below L (e.g. limit placed above
      //     market), this is true on the very next bar → immediate fill.
      //     Otherwise we wait for a bar whose wick reaches down to L.
      //   - Sell limit at L fills when bar.high ≥ L (price reached up
      //     to or above the limit at some point during the bar).
      //
      // Earlier the engine also required bar.close ≤ bar.open (for buy)
      // / ≥ (for sell) to ensure the bar was "moving toward" the limit.
      // That gate over-rejected long-wick / counter-direction bars where
      // price still touched the limit — incorrect for real markets.
      if (order.side === 'buy')  return bar.low  <= order.price;
      if (order.side === 'sell') return bar.high >= order.price;
      return false;
    }

    // ----- Fill settlement: commission, position, OCO, bracket arming -----

    function _fillOrder(order, fillPrice, bar) {
      order.status = 'filled';
      order.fillPrice = fillPrice;
      order.filledAtBarTs = bar.timestamp;
      // Commission lands on the order regardless of whether it opens or
      // closes a position — both sides pay.
      order.commission = commissionPer() * order.qty;
      state.balance -= order.commission;

      // Drop from pending list before mutating positions, so any nested
      // queries during _applyOrderToPosition see a consistent state.
      state.pendingOrders = state.pendingOrders.filter(o => o.id !== order.id);

      _applyOrderToPosition(order, fillPrice, bar);

      // Parent fill → arm its children. Sibling fill cancels the other (legacy
      // 1:1 OCO). Then, for a multi-segment reduce-only bracket, clamp the
      // surviving exit legs down to whatever qty is still open.
      _activateBracketChildren(order.id);
      _cancelOcoSibling(order);
      _reconcileExitLegs(order);
    }

    // After an EXIT leg (bracket child) fills and PARTIALLY reduces the
    // position, clamp every remaining exit leg of the same bracket down to the
    // still-open qty (reduce-only). This is what lets "close 1 lot at TP1, run
    // the rest to TP2, SL covers the remainder" work with NO manual re-draw:
    // when TP1 fills, the SL and TP2 keep guarding the runner at the right size.
    // Full-close cancellation of the group is handled by
    // _cancelDanglingChildrenFor (fired from _applyOrderToPosition at qty→0).
    function _reconcileExitLegs(order) {
      if (!order.bracketParentId) return;
      const pos = state.positions[0] || null;
      const openQty = pos ? pos.qty : 0;
      if (openQty <= 1e-9) return;   // fully closed → dangling-cancel already ran
      for (const o of state.pendingOrders) {
        if (o.bracketParentId === order.bracketParentId
            && o.status === 'pending' && o.qty > openQty) {
          o.qty = openQty;
        }
      }
    }

    function _activateBracketChildren(parentId) {
      for (const o of state.pendingOrders) {
        if (o.bracketParentId === parentId && o.status === 'pending') {
          o.active = true;
        }
      }
    }

    function _cancelOcoSibling(order) {
      if (!order.ocoSiblingId) return;
      const sib = state.orderHistory.find(o => o.id === order.ocoSiblingId);
      if (!sib || sib.status !== 'pending') return;
      sib.status = 'cancelled';
      state.pendingOrders = state.pendingOrders.filter(o => o.id !== sib.id);
    }

    function _applyOrderToPosition(order, fillPrice, bar) {
      // Single-position model: the engine assumes only one position is
      // open at a time. Same-side adds; opposite-side closes / flips.
      // Multi-symbol / multi-position can be a future extension; the spec
      // doesn't ask for it and nothing in the screenshots implies it.
      const desiredSide = order.side === 'buy' ? 'long' : 'short';
      const pos = state.positions[0] || null;

      if (!pos) {
        state.positions.push(_newPosition(order, fillPrice, bar, desiredSide));
        return;
      }

      if (pos.side === desiredSide) {
        // Same side → average entry, increment qty.
        const newQty = pos.qty + order.qty;
        pos.avgEntryPrice = (pos.avgEntryPrice * pos.qty + fillPrice * order.qty) / newQty;
        // Snapshot prior cumulative entry qty BEFORE bumping pos.qty
        // so the fallback (older pos rows without entryQty) reads
        // the pre-scale-in remaining qty, not newQty.
        const priorEntryQty = (pos.entryQty != null) ? pos.entryQty : pos.qty;
        pos.qty = newQty;
        pos.entryQty = priorEntryQty + order.qty;
        pos.entryOrderIds.push(order.id);
        return;
      }

      // Opposite side → close (and possibly flip).
      const closeQty = Math.min(pos.qty, order.qty);
      const realised = pnlInUSD(pos.side, pos.avgEntryPrice, fillPrice, closeQty);
      pos.realisedPnL += realised;
      pos.commissionPaid += order.commission * (closeQty / order.qty);
      pos.exitOrderIds.push(order.id);
      pos.qty -= closeQty;
      state.balance += realised;

      if (pos.qty <= 1e-9) {
        // Fully closed.
        pos.qty = 0;
        // A closed position has NO open exposure, so its unrealised P&L is
        // zero. _updateUnrealised only touches still-open positions, so
        // without this the last open-bar's unrealised would linger and the
        // trade-history netPL (realised + unrealised − commission) would
        // double-count it. All P&L for a closed trade lives in realisedPnL.
        pos.unrealisedPnL = 0;
        pos.closedAtBarTs = bar.timestamp;
        pos.closeReason = _deriveCloseReason(order);
        state.positions = state.positions.filter(p => p.id !== pos.id);
        state.positionHistory.push(pos);
        // Cancel any *other* pending bracket children of this position's
        // entry — they're dangling now that the position is closed (e.g.
        // closing manually after entry should also cancel SL+TP). The
        // OCO sibling of this very order is already handled above.
        _cancelDanglingChildrenFor(pos);
      }

      // Flip: order qty exceeded position qty.
      const flipQty = order.qty - closeQty;
      if (flipQty > 1e-9) {
        const flipped = _newPosition(
          { ...order, qty: flipQty },
          fillPrice, bar,
          desiredSide,
        );
        // The flip leg's commission was already paid above (applied to the
        // whole order). Don't double-count it on the new position.
        flipped.commissionPaid = 0;
        state.positions.push(flipped);
      }
    }

    function _newPosition(order, fillPrice, bar, side) {
      return {
        id: _nextPositionId++,
        side,                                    // 'long' | 'short'
        qty: order.qty,
        // Cumulative entered qty over this position's lifetime — used
        // by 交易清單 / xlsx as the "trade size" since `qty` is the
        // *remaining* open qty and goes to 0 once the position fully
        // closes (which made the displayed size show 0 for every
        // closed trade — the user-reported bug). Scale-ins increment
        // this; closes do not touch it.
        entryQty: order.qty,
        avgEntryPrice: fillPrice,
        entryOrderIds: [order.id],
        exitOrderIds: [],
        realisedPnL: 0,                          // gross (pre-commission)
        unrealisedPnL: 0,                        // updated on every bar
        commissionPaid: order.commission || 0,   // running total
        mae: 0,                                  // worst (most negative) USD seen
        mfe: 0,                                  // best  (most positive) USD seen
        openedAtBarTs: bar.timestamp,
        closedAtBarTs: null,
        closeReason: null,                       // 'tp_hit'|'sl_hit'|'manual'|'reverse'
        // branching-replay-spec §7.5: positions inherit branchId from
        // the entry order. Spec §2 invariant: a trade's branchId is
        // immutable once set — closed positions retain their original
        // branch tag for retroactive PnL bucketing.
        branchId: order.branchId || 'main',
        // Pre-commitment fields — populated at entry time, immutable
        // afterwards by convention. Step 6 enforces the immutability via
        // UI; the engine just stores the snapshot.
        initialDirection: side,
        initialSetupTag: order.setupTag || null,
        initialSL: null,                         // filled in by host
        initialTP: null,                         // filled in by host
        preCommitmentLockedAt: bar.timestamp,
      };
    }

    function _deriveCloseReason(closingOrder) {
      // A child of the position's entry order is a bracket leg. We
      // distinguish TP vs SL by the leg's *original* type — note that a
      // stop_limit that converted to limit still counts as a stop-loss
      // leg, because we tag triggeredAt during the conversion.
      if (closingOrder.bracketParentId) {
        if (closingOrder.triggeredAt != null) return 'sl_hit';     // stop_limit SL
        if (closingOrder.type === 'limit')   return 'tp_hit';
        if (closingOrder.type === 'stop')    return 'sl_hit';
      }
      // 平倉反手 — single market order sized 2× to flip the position.
      // Distinct from 'manual' so trade history can render it differently.
      if (closingOrder.isReverse) return 'reverse';
      return 'manual';
    }

    function _cancelDanglingChildrenFor(pos) {
      // After full close, any pending bracket child whose parent was an
      // entry of THIS position is dangling — kill them so they don't fire
      // on a phantom position. Sibling-on-fill OCO already handled the
      // direct sibling case in _cancelOcoSibling.
      const entryIds = new Set(pos.entryOrderIds);
      for (const o of state.pendingOrders.slice()) {
        if (o.bracketParentId != null && entryIds.has(o.bracketParentId)) {
          o.status = 'cancelled';
          state.pendingOrders = state.pendingOrders.filter(p => p.id !== o.id);
        }
      }
    }

    function _updateExtremes(pos, bar) {
      // Long: high reaches favour, low reaches adverse.  Short: flipped.
      const peakPrice   = pos.side === 'long' ? bar.high : bar.low;
      const troughPrice = pos.side === 'long' ? bar.low  : bar.high;
      const mfeUSD = pnlInUSD(pos.side, pos.avgEntryPrice, peakPrice,   pos.qty);
      const maeUSD = pnlInUSD(pos.side, pos.avgEntryPrice, troughPrice, pos.qty);
      if (mfeUSD > pos.mfe) pos.mfe = mfeUSD;
      if (maeUSD < pos.mae) pos.mae = maeUSD;
      pos.unrealisedPnL = pnlInUSD(pos.side, pos.avgEntryPrice, bar.close, pos.qty);
    }

    // ----- Account snapshot helpers -----

    function _equity() {
      let openPnL = 0;
      for (const p of state.positions) openPnL += p.unrealisedPnL;
      return state.balance + openPnL;
    }

    function reset() {
      state.balance = state.startingBalance;
      state.pendingOrders = [];
      state.positions = [];
      state.orderHistory = [];
      state.positionHistory = [];
      state.lastBar = null;
    }

    // ---------------- Persistence: serialize / restore -----------------
    //
    // Schema v1. Saved per (layout, symbol) under
    // `user_data/layouts/<id>/sim/<symbol>.json`. The `spec` field is
    // intentionally NOT serialized — it's symbol-specific config that
    // lives in `symbol_specs.js` and is re-injected by the caller on
    // restore. This way a future spec edit (e.g. commission change)
    // applies to all subsequent fills without us having to migrate
    // saved state.
    //
    // ID counters (`_nextOrderId / _nextPositionId`) are module-level
    // (shared across SimEngine instances). On restore we bump them to
    // `max(saved id) + 1` so newly-placed orders don't collide with
    // restored ones — even though the underlying counters were never
    // designed for multi-instance use.

    function serialize() {
      return {
        version: 1,
        accountSize:     state.accountSize,
        startingBalance: state.startingBalance,
        balance:         state.balance,
        pendingOrders:   state.pendingOrders.map(o => ({ ...o })),
        orderHistory:    state.orderHistory.map(o => ({ ...o })),
        positions:       state.positions.map(p => ({ ...p })),
        positionHistory: state.positionHistory.map(p => ({ ...p })),
        lastBar:         state.lastBar ? { ...state.lastBar } : null,
      };
    }

    function restore(snap) {
      if (!snap || snap.version !== 1) return false;
      if (Number.isFinite(snap.accountSize))     state.accountSize     = snap.accountSize;
      if (Number.isFinite(snap.startingBalance)) state.startingBalance = snap.startingBalance;
      if (Number.isFinite(snap.balance))         state.balance         = snap.balance;
      state.pendingOrders   = Array.isArray(snap.pendingOrders)   ? snap.pendingOrders.map(o => ({ ...o })) : [];
      state.orderHistory    = Array.isArray(snap.orderHistory)    ? snap.orderHistory.map(o => ({ ...o })) : [];
      state.positions       = Array.isArray(snap.positions)       ? snap.positions.map(p => ({ ...p })) : [];
      state.positionHistory = Array.isArray(snap.positionHistory) ? snap.positionHistory.map(p => ({ ...p })) : [];
      state.lastBar         = snap.lastBar ? { ...snap.lastBar } : null;
      // Bump module-level ID counters past any restored IDs so the
      // next placeOrder / new position doesn't collide.
      const maxO = Math.max(0,
        ...state.orderHistory.map(o => Number(o.id) || 0),
        ...state.pendingOrders.map(o => Number(o.id) || 0));
      const maxP = Math.max(0,
        ...state.positions.map(p => Number(p.id) || 0),
        ...state.positionHistory.map(p => Number(p.id) || 0));
      if (_nextOrderId    <= maxO) _nextOrderId    = maxO + 1;
      if (_nextPositionId <= maxP) _nextPositionId = maxP + 1;
      // Backfill entryQty for positions saved before this field
      // existed (added in §4o follow-up). Sum the qty of each
      // position's entry orders from orderHistory. If those orders
      // are missing too (shouldn't happen), leave entryQty
      // undefined and let UI fallback to pos.qty.
      const ordersById = new Map();
      for (const o of state.orderHistory) ordersById.set(o.id, o);
      const backfillEntryQty = (p) => {
        if (p.entryQty != null) return;
        if (!Array.isArray(p.entryOrderIds) || !p.entryOrderIds.length) return;
        let sum = 0;
        for (const id of p.entryOrderIds) {
          const o = ordersById.get(id);
          if (o && Number.isFinite(o.qty)) sum += o.qty;
        }
        if (sum > 0) p.entryQty = sum;
      };
      state.positions.forEach(backfillEntryQty);
      state.positionHistory.forEach(backfillEntryQty);
      return true;
    }

    // ---------------- Trade-history editing ---------------------------
    //
    // Both ops are destructive and idempotent. They wipe orders linked
    // to the affected positions AND reverse the position's balance
    // impact (realisedPnL minus commissionPaid) so the account number
    // stays internally consistent. Open positions get the same
    // treatment plus their bracket children cancelled.
    //
    // Spec from in-session UX rules:
    //   - deleteTrade: row-level ✕ in 交易清單. Single click, no modal
    //     (low-cost mistake; SimController PUT happens after so the
    //     server has a backup of the prior state).
    //   - clearBranch: drawer-top button. STRONG: requires modal in
    //     the UI layer (this method itself does no asking).

    function deleteTrade(positionId) {
      let pos = state.positionHistory.find(p => p.id === positionId);
      let openIdx = -1;
      if (!pos) {
        openIdx = state.positions.findIndex(p => p.id === positionId);
        if (openIdx >= 0) pos = state.positions[openIdx];
      }
      if (!pos) return false;
      _reverseBalance(pos);
      _wipePositionOrders(pos);
      if (openIdx >= 0) state.positions.splice(openIdx, 1);
      else state.positionHistory = state.positionHistory.filter(p => p.id !== positionId);
      return true;
    }

    function clearBranch(branchId) {
      if (!branchId) return false;
      // Reverse balance for closed AND open positions on this branch.
      // closedHistory: undo realisedPnL (subtract) + refund commission
      //   (add back). open: only commission refund — they had no
      //   realisedPnL yet.
      for (const p of state.positionHistory) {
        if (p.branchId === branchId) _reverseBalance(p);
      }
      for (const p of state.positions) {
        if (p.branchId === branchId
            && Number.isFinite(p.commissionPaid)) {
          state.balance += p.commissionPaid;
        }
      }
      state.positions       = state.positions.filter(p => p.branchId !== branchId);
      state.positionHistory = state.positionHistory.filter(p => p.branchId !== branchId);
      state.orderHistory    = state.orderHistory.filter(o => o.branchId !== branchId);
      state.pendingOrders   = state.pendingOrders.filter(o => o.branchId !== branchId);
      return true;
    }

    function _reverseBalance(pos) {
      if (Number.isFinite(pos.realisedPnL))    state.balance -= pos.realisedPnL;
      if (Number.isFinite(pos.commissionPaid)) state.balance += pos.commissionPaid;
    }

    function _wipePositionOrders(pos) {
      const drop = new Set(pos.entryOrderIds || []);
      // Bracket children of those entries — find them in orderHistory.
      for (const o of state.orderHistory) {
        if (o.bracketParentId != null && drop.has(o.bracketParentId)) {
          drop.add(o.id);
        }
      }
      if (drop.size) {
        state.orderHistory  = state.orderHistory.filter(o => !drop.has(o.id));
        state.pendingOrders = state.pendingOrders.filter(o => !drop.has(o.id));
      }
    }

    /** Roll engine state back as if no events happened after `cutoffTs`.
     *  Used by replay step-back when the user wants to "discard recent
     *  activity" rather than fork a new branch (branching-replay-spec
     *  §3.1 / §4.1).
     *
     *  Rules:
     *    - Pending orders with `createdAtBarTs > cutoff` → cancelled.
     *    - Positions in `positions[]` with `openedAtBarTs > cutoff` →
     *      removed entirely (their bracket children too).
     *    - Closed positions in `positionHistory[]` with
     *      `closedAtBarTs > cutoff`:
     *        * if `openedAtBarTs > cutoff` too → remove entirely.
     *        * else → revert the close (push back to positions, clear
     *          closedAtBarTs / closeReason, drop the realised PnL from
     *          this exit and refund the exit-leg commission).
     *    - Balance recomputed: starting balance plus all surviving
     *      realisedPnL minus all surviving commissions paid.
     *
     *  Returns a summary `{ removedPositions, revertedPositions,
     *  cancelledOrders, deltaBalance }` so the caller can log /
     *  display what changed. */
    function rollbackToBarTs(cutoffTs) {
      if (!Number.isFinite(cutoffTs)) {
        return { removedPositions: 0, revertedPositions: 0, cancelledOrders: 0, deltaBalance: 0 };
      }
      const balanceBefore = state.balance;

      // 1. Cancel pending orders created after cutoff.
      let cancelledOrders = 0;
      const survivingPending = [];
      for (const o of state.pendingOrders) {
        if (Number.isFinite(o.createdAtBarTs) && o.createdAtBarTs > cutoffTs) {
          o.status = 'cancelled';
          cancelledOrders++;
        } else {
          survivingPending.push(o);
        }
      }
      state.pendingOrders = survivingPending;

      // 2. Walk positionHistory in reverse — remove or revert closed
      // positions that closed past the cutoff. Reverting re-opens the
      // position (push back to state.positions) so it'll continue
      // ticking under the new cursor.
      let removedPositions = 0;
      let revertedPositions = 0;
      const survivingHistory = [];
      for (const p of state.positionHistory) {
        const openedAfter = Number.isFinite(p.openedAtBarTs) && p.openedAtBarTs > cutoffTs;
        const closedAfter = Number.isFinite(p.closedAtBarTs) && p.closedAtBarTs > cutoffTs;
        if (closedAfter && openedAfter) {
          // Both happened in danger zone → drop the whole position.
          // Cancel its bracket children too (they were placed after
          // entry, also in the zone).
          _cancelChildrenOfPosition(p);
          removedPositions++;
          continue;
        }
        if (closedAfter && !openedAfter) {
          // Position was open before cutoff, closed after → revert.
          // Drop the realised PnL contribution from this exit and
          // refund any exit-leg commission. The position re-opens with
          // its original entry but no exit.
          const exitOrderId = p.exitOrderIds && p.exitOrderIds.length
            ? p.exitOrderIds[p.exitOrderIds.length - 1] : null;
          const exitOrder = exitOrderId != null
            ? state.orderHistory.find(o => o.id === exitOrderId) : null;
          // Restore the position fields prior to close.
          p.qty = (p.entryOrderIds || [])
            .map(id => state.orderHistory.find(o => o.id === id))
            .filter(Boolean)
            .reduce((sum, o) => sum + (o.qty || 0), 0);
          // Drop realised PnL accumulated by this close.
          p.realisedPnL = 0;
          // Refund exit-leg commission if we tagged it.
          if (exitOrder && Number.isFinite(exitOrder.commission)) {
            p.commissionPaid = Math.max(0, (p.commissionPaid || 0) - exitOrder.commission);
          }
          p.closedAtBarTs = null;
          p.closeReason = null;
          if (Array.isArray(p.exitOrderIds)) p.exitOrderIds = [];
          state.positions.push(p);
          revertedPositions++;
          continue;
        }
        // Closed entirely before cutoff → keep as-is.
        survivingHistory.push(p);
      }
      state.positionHistory = survivingHistory;

      // 3. Walk live positions[] — remove ones opened in the zone.
      const survivingOpen = [];
      for (const p of state.positions) {
        if (Number.isFinite(p.openedAtBarTs) && p.openedAtBarTs > cutoffTs) {
          _cancelChildrenOfPosition(p);
          removedPositions++;
        } else {
          survivingOpen.push(p);
        }
      }
      state.positions = survivingOpen;

      // 4. Recompute balance from scratch — easier than tracking
      // refunds + reversals. starting + surviving realised PnL minus
      // surviving commissions paid.
      let recomputed = state.startingBalance;
      for (const p of state.positionHistory) {
        recomputed += (p.realisedPnL || 0) - (p.commissionPaid || 0);
      }
      for (const p of state.positions) {
        // Open positions: only entry-leg commission has been paid; PnL
        // is unrealised so doesn't affect balance.
        recomputed -= (p.commissionPaid || 0);
      }
      state.balance = recomputed;

      return {
        removedPositions, revertedPositions, cancelledOrders,
        deltaBalance: state.balance - balanceBefore,
      };
    }

    /** Cancel any pending bracket children whose parent is one of the
     *  given position's entry orders. Used by rollbackToBarTs when a
     *  position is being removed entirely so its TP/SL legs don't
     *  dangle as orphan orders. */
    function _cancelChildrenOfPosition(pos) {
      if (!pos || !pos.entryOrderIds) return;
      const entryIds = new Set(pos.entryOrderIds);
      const survivors = [];
      for (const o of state.pendingOrders) {
        if (o.bracketParentId != null && entryIds.has(o.bracketParentId)) {
          o.status = 'cancelled';
        } else {
          survivors.push(o);
        }
      }
      state.pendingOrders = survivors;
    }

    return {
      // Mutators
      placeOrder,
      placeBracket,
      cancelOrder,
      modifyOrder,
      processBar,
      processSubBar,
      reset,
      rollbackToBarTs,
      deleteTrade,
      clearBranch,
      // Persistence
      serialize,
      restore,
      // Read-only snapshots (returned arrays are shallow copies so the
      // caller can't accidentally mutate engine state).
      getPendingOrders:   () => state.pendingOrders.slice(),
      getOrderHistory:    () => state.orderHistory.slice(),
      getPositions:       () => state.positions.slice(),
      getPositionHistory: () => state.positionHistory.slice(),
      getAccount: () => ({
        startingBalance: state.startingBalance,
        balance:         state.balance,
        equity:          _equity(),
        openPositions:   state.positions.length,
      }),
      // Useful for the UI panel: lookup an order by id without re-walking
      // history. Returns null if not found.
      getOrder: (id) => state.orderHistory.find(o => o.id === id) || null,
    };
  }

  // Expose. Module-level reset is occasionally useful for tests that
  // want monotonically-increasing IDs but a clean count between runs;
  // production code should use engine.reset() instead.
  function _resetIdCounters() {
    _nextOrderId = 1;
    _nextPositionId = 1;
  }

  window.SimEngine = { create, _resetIdCounters };
})();
